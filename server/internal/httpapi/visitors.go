package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/netip"
	"strings"

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
	"Enter":        true,
	"GetLiveness":  true,
	"GetReadiness": true,
}

type (
	visitorKey  struct{}
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
		if openOperations[operationID] {
			return next(ctx, w, r, request)
		}
		var token string
		if c, err := r.Cookie(cookieName); err == nil {
			token = c.Value
		}
		visitor, err := v.identity.Resolve(ctx, token)
		if errors.Is(err, identity.ErrNoVisitor) {
			writeError(w, http.StatusUnauthorized, visitorRequired.Code, visitorRequired.Message)
			return nil, nil
		}
		if err != nil {
			v.errs.internal(w, r, err)
			return nil, nil
		}
		return next(context.WithValue(ctx, visitorKey{}, visitor), w, r, request)
	}
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
		Body:    visitorBody(v),
		Headers: api.Enter201ResponseHeaders{SetCookie: cookie.String()},
	}, nil
}

func (s *server) GetMe(ctx context.Context, _ api.GetMeRequestObject) (api.GetMeResponseObject, error) {
	return api.GetMe200JSONResponse(visitorBody(currentVisitor(ctx))), nil
}

func (s *server) RenameMe(ctx context.Context, req api.RenameMeRequestObject) (api.RenameMeResponseObject, error) {
	v, err := s.identity.Rename(ctx, currentVisitor(ctx).ID, req.Body.Name)
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
	return api.RenameMe200JSONResponse(visitorBody(v)), nil
}

// visitorRequired is the answer to a request without a valid visitor cookie.
var visitorRequired = api.VisitorRequiredJSONResponse{
	Code: "visitor_required", Message: "no valid visitor cookie; enter through the access link",
}

func visitorBody(v identity.Visitor) api.Visitor {
	return api.Visitor{Id: v.ID, Name: v.Name}
}

func invalidName(err error) api.InvalidNameJSONResponse {
	return api.InvalidNameJSONResponse{Code: "invalid_name", Message: err.Error()}
}

func nameTaken() api.NameTakenJSONResponse {
	return api.NameTakenJSONResponse{Code: "name_taken", Message: "another visitor has this name"}
}
