package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
)

// cookieName is the visitor cookie, named as in the contract's visitorCookie
// security scheme.
const cookieName = "falky_visitor"

// cookieMaxAge is how long a browser keeps the visitor cookie: 400 days, the
// longest browsers allow.
const cookieMaxAge = 400 * 24 * 60 * 60

// openOperations are the operations that need no visitor: those the contract
// marks with an empty security requirement. Every other operation does.
var openOperations = map[string]bool{
	"Enter":                true,
	"GetLiveness":          true,
	"GetReadiness":         true,
	"BeginRegistration":    true,
	"FinishRegistration":   true,
	"BeginAuthentication":  true,
	"FinishAuthentication": true,
	"BeginRecovery":        true,
	"FinishRecovery":       true,
}

type (
	visitorKey  struct{}
	sessionKey  struct{}
	requestKey  struct{}
	writerKey   struct{}
	clientIPKey struct{}
)

// visitorResolver resolves the visitor cookie of each operation that needs a
// visitor, and answers 401 without running the operation when it does not
// resolve.
type visitorResolver struct {
	identity *identity.Service
	errs     errorWriter
}

func (v visitorResolver) middleware(next api.StrictHandlerFunc, operationID string) api.StrictHandlerFunc {
	return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {
		ctx = context.WithValue(ctx, clientIPKey{}, clientIP(r))
		ctx = context.WithValue(ctx, requestKey{}, r)
		ctx = context.WithValue(ctx, writerKey{}, w)
		if openOperations[operationID] {
			return next(ctx, w, r, request)
		}
		session, ok := v.session(w, r.WithContext(ctx))
		if !ok {
			return nil, nil
		}
		ctx = context.WithValue(ctx, sessionKey{}, session)
		return next(context.WithValue(ctx, visitorKey{}, session.Visitor), w, r, request)
	}
}

// visitor resolves the visitor cookie of r. When it does not resolve, it
// answers 401 (or 500 when resolving fails) and reports false.
func (v visitorResolver) visitor(w http.ResponseWriter, r *http.Request) (identity.Visitor, bool) {
	session, ok := v.session(w, r)
	return session.Visitor, ok
}

func (v visitorResolver) session(w http.ResponseWriter, r *http.Request) (identity.Session, bool) {
	session, err := v.identity.ResolveSession(r.Context(), sessionToken(r))
	if errors.Is(err, identity.ErrNoVisitor) || errors.Is(err, identity.ErrDisabled) {
		writeError(w, 401, visitorRequired.Code, visitorRequired.Message)
		return identity.Session{}, false
	}
	if err != nil {
		v.errs.internal(w, r, err)
		return identity.Session{}, false
	}
	return session, true
}

func currentSession(ctx context.Context) identity.Session {
	v, _ := ctx.Value(sessionKey{}).(identity.Session)
	return v
}

func sessionToken(r *http.Request) string {
	if c, err := r.Cookie(cookieName); err == nil {
		return c.Value
	}
	return ""
}

// currentVisitor is the visitor the middleware resolved for this request.
func currentVisitor(ctx context.Context) identity.Visitor {
	v, _ := ctx.Value(visitorKey{}).(identity.Visitor)
	return v
}

// clientIP is the client address the reverse proxy reports: the last entry of
// X-Forwarded-For, which the proxy itself sets from the connection it accepted.
// Earlier entries come from the client and are ignored. The peer address is
// never used, since every request arrives from the proxy; without the header
// all requests share the empty address. An IPv6 address stands for its /64
// network, which one client usually holds whole.
func clientIP(r *http.Request) string {
	values := r.Header.Values("X-Forwarded-For")
	if len(values) == 0 {
		return ""
	}
	last := values[len(values)-1]
	last = strings.TrimSpace(last[strings.LastIndexByte(last, ',')+1:])
	addr, err := netip.ParseAddr(last)
	if err != nil {
		return last
	}
	if addr = addr.Unmap(); addr.Is4() {
		return addr.String()
	}
	return netip.PrefixFrom(addr.WithZone(""), 64).Masked().String()
}

func (s *server) Enter(ctx context.Context, req api.EnterRequestObject) (api.EnterResponseObject, error) {
	ip, _ := ctx.Value(clientIPKey{}).(string)
	if !s.enterLimit.Allow(ip) {
		return api.Enter429JSONResponse{Code: "rate_limited", Message: "too many attempts to enter; try again later"}, nil
	}
	v, token, err := s.identity.Enter(ctx, req.Body.Secret, req.Body.Name)
	switch {
	case errors.Is(err, identity.ErrWrongSecret):
		return api.Enter403JSONResponse{Code: "invalid_link", Message: "the access link is not valid"}, nil
	case errors.Is(err, identity.ErrInvalidName):
		return api.Enter400JSONResponse{InvalidNameJSONResponse: invalidName(err)}, nil
	case errors.Is(err, identity.ErrNameTaken):
		return api.Enter409JSONResponse{NameTakenJSONResponse: nameTaken()}, nil
	case err != nil:
		return nil, err
	}
	cookie := &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/api",
		MaxAge:   cookieMaxAge,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	}
	return api.Enter201JSONResponse{
		Body:    s.visitorBody(v),
		Headers: api.Enter201ResponseHeaders{SetCookie: cookie.String()},
	}, nil
}

func (s *server) GetMe(ctx context.Context, _ api.GetMeRequestObject) (api.GetMeResponseObject, error) {
	return api.GetMe200JSONResponse(s.visitorBody(currentVisitor(ctx))), nil
}

func (s *server) RenameMe(ctx context.Context, req api.RenameMeRequestObject) (api.RenameMeResponseObject, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	if _, err := s.identity.ValidateSession(ctx, currentSession(ctx)); err != nil {
		if errors.Is(err, identity.ErrNoVisitor) {
			return api.RenameMe401JSONResponse{VisitorRequiredJSONResponse: visitorRequired}, nil
		}
		return nil, err
	}
	v, effects, err := s.identity.RenameWithEffects(ctx, currentVisitor(ctx).ID, req.Body.Name)
	switch {
	case errors.Is(err, identity.ErrInvalidName):
		return api.RenameMe400JSONResponse{InvalidNameJSONResponse: invalidName(err)}, nil
	case errors.Is(err, identity.ErrNameTaken):
		return api.RenameMe409JSONResponse{NameTakenJSONResponse: nameTaken()}, nil
	case errors.Is(err, identity.ErrNoVisitor):
		return api.RenameMe401JSONResponse{VisitorRequiredJSONResponse: visitorRequired}, nil
	case err != nil:
		return nil, err
	}
	if err := s.lifecycle.Apply(ctx, effects); err != nil {
		return nil, err
	}
	if s.voice != nil {
		if err := s.voice.Refresh(ctx); err != nil {
			return nil, err
		}
	}
	if s.events.Hub != nil {
		s.events.Hub.RefreshIdentity(v.ID)
	}
	return api.RenameMe200JSONResponse(s.visitorBody(v)), nil
}

// visitorRequired is the answer to a request without a valid visitor cookie.
var visitorRequired = api.VisitorRequiredJSONResponse{
	Code: "visitor_required", Message: "no valid visitor cookie; enter through the access link",
}

// visitorBody is v as the contract shows it.
func (s *server) visitorBody(v identity.Visitor) api.Visitor {
	return api.Visitor{Id: v.ID, Name: v.Name, NameTaken: s.identity.NameTaken(v), Colour: colourBody(v.Colour)}
}

func invalidName(err error) api.InvalidNameJSONResponse {
	return api.InvalidNameJSONResponse{Code: "invalid_name", Message: err.Error()}
}

func nameTaken() api.NameTakenJSONResponse {
	return api.NameTakenJSONResponse{Code: "name_taken", Message: "another visitor has this name"}
}

// yourNameTaken is the answer refusing live updates or voice to a visitor
// whose name another connected visitor holds.
var yourNameTaken = api.Error{Code: "name_taken", Message: "another visitor has your name; rename first"}

// SetMyColour persists first, then publishes outside the writer transaction.
func (s *server) SetMyColour(ctx context.Context, req api.SetMyColourRequestObject) (api.SetMyColourResponseObject, error) {
	c, err := s.identity.SetColour(ctx, currentVisitor(ctx).ID, string(req.Body.Palette))
	if errors.Is(err, identity.ErrInvalidPalette) {
		return api.SetMyColour400JSONResponse{Code: "invalid_palette", Message: "choose one of the sixteen palettes"}, nil
	}
	if err != nil {
		return nil, err
	}
	s.events.VisitorColourChanged(c)
	return api.SetMyColour200JSONResponse(colourBody(c)), nil
}

func (s *server) LookupVisitorColours(ctx context.Context, req api.LookupVisitorColoursRequestObject) (api.LookupVisitorColoursResponseObject, error) {
	if req.Body.VisitorIds == nil || len(req.Body.VisitorIds) > 100 {
		return api.LookupVisitorColours400JSONResponse{Code: "invalid_request", Message: "visitorIds must be an array of at most 100 IDs"}, nil
	}
	colours, err := s.identity.Colours(ctx, req.Body.VisitorIds)
	if err != nil {
		return nil, err
	}
	result := make([]api.VisitorColour, 0, len(colours))
	for _, colour := range colours {
		result = append(result, colourBody(colour))
	}
	return api.LookupVisitorColours200JSONResponse{Colours: result}, nil
}

func colourBody(c identity.Colour) api.VisitorColour {
	return api.VisitorColour{VisitorId: c.VisitorID, Palette: api.PaletteName(c.Palette), Revision: c.Revision}
}
