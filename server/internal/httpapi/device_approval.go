package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

const signInCookie = "__Host-falky-signin"

// SignInLimits separates anonymous attempts, actual allocations and phone operations.
type SignInLimits struct {
	LinkAttempts, QRAttempts, QRBrowserAllocations, QRIPAllocations, QRSessionAttempts, CandidateAttempts *platform.Limiter
}

func (l *SignInLimits) defaults(now func() time.Time) {
	if l.LinkAttempts == nil {
		l.LinkAttempts = platform.NewLimiter(20, 3*time.Second, now)
	}
	if l.QRAttempts == nil {
		l.QRAttempts = platform.NewLimiter(20, 3*time.Second, now)
	}
	if l.QRBrowserAllocations == nil {
		l.QRBrowserAllocations = platform.NewLimiter(3, 100*time.Second, now)
	}
	if l.QRIPAllocations == nil {
		l.QRIPAllocations = platform.NewLimiter(10, 30*time.Second, now)
	}
	if l.QRSessionAttempts == nil {
		l.QRSessionAttempts = platform.NewLimiter(10, 6*time.Second, now)
	}
	if l.CandidateAttempts == nil {
		l.CandidateAttempts = platform.NewLimiter(20, 3*time.Second, now)
	}
}

func signInBinding(r *http.Request) string {
	if c, err := r.Cookie(signInCookie); err == nil {
		return c.Value
	}
	return ""
}

func signInBindingCookie(value string) string {
	return (&http.Cookie{Name: signInCookie, Value: value, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 600}).String()
}

func signInRateLimited(w http.ResponseWriter, wait time.Duration) {
	seconds := max(1, int(math.Ceil(wait.Seconds())))
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	writeError(w, http.StatusTooManyRequests, "rate_limited", "too many sign-in attempts; try again later")
}

func (s *server) signInError(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	_, w := accountHTTP(ctx)
	var cooldown *identity.SignInCooldownError
	switch {
	case errors.As(err, &cooldown):
		signInRateLimited(w, cooldown.RetryAfter)
	case errors.Is(err, identity.ErrAccountSwitchRequired), errors.Is(err, identity.ErrAlreadySignedIn), errors.Is(err, identity.ErrSignInPendingCap), errors.Is(err, identity.ErrSignInConflict):
		writeError(w, http.StatusConflict, err.Error(), "sign-in conflicts with the current browser or request state")
	default:
		s.accountError(ctx, err)
	}
	return true
}

func (s *server) signInApplied(ctx context.Context, effects identity.Effects, err error) bool {
	// A wrong-code rejection can commit cancellation; publish it before mapping the rejection.
	enforcement := s.lifecycle.Apply(ctx, effects)
	if s.signInError(ctx, err) {
		return true
	}
	return s.signInError(ctx, enforcement)
}

func signInRequestBody(v identity.SignInRequestView) api.SignInRequest {
	return api.SignInRequest{Id: v.ID, Type: api.SignInRequestType(v.Type), State: api.SignInRequestState(v.State), LinkId: v.LinkID, Version: v.Version, RequesterUserAgent: v.RequesterUserAgent, CreatedAt: v.CreatedAt, ExpiresAt: v.ExpiresAt, ApprovedAt: v.ApprovedAt, ConsumedAt: v.ConsumedAt}
}

func signInLinkBody(v identity.SignInLinkView) api.SignInLink {
	requests := make([]api.SignInRequest, 0, len(v.Requests))
	for _, r := range v.Requests {
		requests = append(requests, signInRequestBody(r))
	}
	return api.SignInLink{Id: v.ID, State: api.SignInLinkState(v.State), Version: v.Version, CreatedAt: v.CreatedAt, ExpiresAt: v.ExpiresAt, ApprovalGrantsRecentProof: v.ApprovalGrantsRecentProof, Requests: requests}
}

func signInBeginBody(v identity.SignInBeginResult) api.SignInBegin {
	return api.SignInBegin{Request: signInRequestBody(v.Request), Code: v.Code, Token: v.QRToken, Url: v.URL}
}

func (s *server) CreateSignInLink(ctx context.Context, req api.CreateSignInLinkRequestObject) (api.CreateSignInLinkResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	result, effects, err := s.identity.CreateSignInLink(ctx, accountToken(ctx))
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.CreateSignInLink200JSONResponse{Body: api.SignInLinkResult{Link: signInLinkBody(result.Link), Token: result.Token, Url: result.URL}}, nil
}

func (s *server) GetSignInLink(ctx context.Context, req api.GetSignInLinkRequestObject) (api.GetSignInLinkResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	result, err := s.identity.SignInLink(ctx, accountToken(ctx), req.LinkId)
	if s.signInError(ctx, err) {
		return nil, nil
	}
	return api.GetSignInLink200JSONResponse(signInLinkBody(result)), nil
}

func (s *server) RevokeSignInLink(ctx context.Context, req api.RevokeSignInLinkRequestObject) (api.RevokeSignInLinkResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	effects, err := s.identity.RevokeSignInLink(ctx, accountToken(ctx), req.LinkId)
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.RevokeSignInLink200JSONResponse{}, nil
}

func (s *server) ApproveSignInLink(ctx context.Context, req api.ApproveSignInLinkRequestObject) (api.ApproveSignInLinkResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	result, effects, err := s.identity.ApproveSignInLink(ctx, accountToken(ctx), req.LinkId, req.Body.Code)
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.ApproveSignInLink200JSONResponse(signInRequestBody(result)), nil
}

func (s *server) DenySignInRequest(ctx context.Context, req api.DenySignInRequestRequestObject) (api.DenySignInRequestResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	effects, err := s.identity.DenySignInRequest(ctx, accountToken(ctx), req.LinkId, req.RequestId)
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.DenySignInRequest200JSONResponse{}, nil
}

func (s *server) BeginSignInRequest(ctx context.Context, req api.BeginSignInRequestRequestObject) (api.BeginSignInRequestResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	r, _ := accountHTTP(ctx)
	result, effects, err := s.identity.BeginSignInRequest(ctx, req.Body.Token, signInBinding(r), accountToken(ctx), r.UserAgent())
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.BeginSignInRequest200JSONResponse{Body: signInBeginBody(result), Headers: api.BeginSignInRequest200ResponseHeaders{SetCookie: signInBindingCookie(result.BrowserSecret)}}, nil
}

func (s *server) BeginQRSignIn(ctx context.Context, req api.BeginQRSignInRequestObject) (api.BeginQRSignInResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	r, _ := accountHTTP(ctx)
	allocate := func(browserHash string) error {
		if !s.signInLimits.QRBrowserAllocations.Allow(browserHash) {
			return &identity.SignInCooldownError{RetryAfter: 100 * time.Second}
		}
		if !s.signInLimits.QRIPAllocations.Allow(clientIP(r)) {
			return &identity.SignInCooldownError{RetryAfter: 30 * time.Second}
		}
		return nil
	}
	result, effects, err := s.identity.BeginQRSignIn(ctx, signInBinding(r), accountToken(ctx), r.UserAgent(), req.Body.Replace, allocate)
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.BeginQRSignIn200JSONResponse{Body: signInBeginBody(result), Headers: api.BeginQRSignIn200ResponseHeaders{SetCookie: signInBindingCookie(result.BrowserSecret)}}, nil
}

func (s *server) PreviewQRSignIn(ctx context.Context, req api.PreviewQRSignInRequestObject) (api.PreviewQRSignInResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	if !s.signInPhoneAllowed(ctx) {
		return nil, nil
	}
	result, err := s.identity.PreviewQRSignIn(ctx, accountToken(ctx), req.Body.Token)
	if s.signInError(ctx, err) {
		return nil, nil
	}
	return api.PreviewQRSignIn200JSONResponse{Request: signInRequestBody(result.Request), ApprovalGrantsRecentProof: result.ApprovalGrantsRecentProof}, nil
}

func (s *server) ApproveQRSignIn(ctx context.Context, req api.ApproveQRSignInRequestObject) (api.ApproveQRSignInResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	if !s.signInPhoneAllowed(ctx) {
		return nil, nil
	}
	result, effects, err := s.identity.ApproveQRSignIn(ctx, accountToken(ctx), req.Body.Token)
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.ApproveQRSignIn200JSONResponse(signInRequestBody(result)), nil
}

func (s *server) DenyQRSignIn(ctx context.Context, req api.DenyQRSignInRequestObject) (api.DenyQRSignInResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	if !s.signInPhoneAllowed(ctx) {
		return nil, nil
	}
	effects, err := s.identity.DenyQRSignIn(ctx, accountToken(ctx), req.Body.Token)
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.DenyQRSignIn200JSONResponse{}, nil
}

func (s *server) CancelQRSignIn(ctx context.Context, req api.CancelQRSignInRequestObject) (api.CancelQRSignInResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	r, _ := accountHTTP(ctx)
	effects, err := s.identity.CancelQRSignIn(ctx, req.RequestId, signInBinding(r))
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.CancelQRSignIn200JSONResponse{}, nil
}

func (s *server) GetSignInRequest(ctx context.Context, req api.GetSignInRequestRequestObject) (api.GetSignInRequestResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	r, _ := accountHTTP(ctx)
	result, err := s.identity.SignInRequest(ctx, req.RequestId, signInBinding(r))
	if s.signInError(ctx, err) {
		return nil, nil
	}
	return api.GetSignInRequest200JSONResponse(signInRequestBody(result)), nil
}

func (s *server) ResendSignInRequest(ctx context.Context, req api.ResendSignInRequestRequestObject) (api.ResendSignInRequestResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	r, _ := accountHTTP(ctx)
	effects, err := s.identity.ResendSignInRequest(ctx, req.RequestId, signInBinding(r), req.Body.Token)
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	return api.ResendSignInRequest200JSONResponse{}, nil
}

func (s *server) FinishSignInRequest(ctx context.Context, req api.FinishSignInRequestRequestObject) (api.FinishSignInRequestResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	r, _ := accountHTTP(ctx)
	result, err := s.identity.FinishSignInRequest(ctx, req.RequestId, signInBinding(r), req.Body.Token, accountToken(ctx))
	effects := result.Effects
	if s.signInApplied(ctx, effects, err) {
		return nil, nil
	}
	remaining := int(result.Session.ExpiresAt.Sub(s.signInNow()) / time.Second)
	if remaining <= 0 {
		return nil, identity.ErrInvalidProof
	}
	cookie := (&http.Cookie{Name: cookieName, Value: result.Token, Path: "/api", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: remaining}).String()
	return api.FinishSignInRequest200JSONResponse{Body: s.sessionBody(result.Session), Headers: api.FinishSignInRequest200ResponseHeaders{SetCookie: cookie}}, nil
}

func (s *server) signInPhoneAllowed(ctx context.Context) bool {
	session, err := s.identity.ResolveSession(ctx, accountToken(ctx))
	if s.signInError(ctx, err) {
		return false
	}
	if session.Kind != identity.Account {
		s.signInError(ctx, identity.ErrNoVisitor)
		return false
	}
	if !s.signInLimits.QRSessionAttempts.Allow(session.ID) {
		_, w := accountHTTP(ctx)
		signInRateLimited(w, 6*time.Second)
		return false
	}
	return true
}

func validateSignInBody(path string, raw []byte) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return false
	}
	var allowed, required string
	switch {
	case path == "/api/accounts/qr-signins":
		allowed = "replace"
	case path == "/api/accounts/signin-requests" || path == "/api/accounts/qr-signins/preview" || path == "/api/accounts/qr-signins/approve" || path == "/api/accounts/qr-signins/deny" || strings.HasSuffix(path, "/resend"):
		allowed = "token"
		required = "token"
	case strings.HasSuffix(path, "/finish"):
		allowed = "token"
	case strings.HasSuffix(path, "/approve"):
		allowed = "code"
		required = "code"
	}
	if required != "" {
		if _, ok := fields[required]; !ok {
			return false
		}
	}
	for key, value := range fields {
		if key != allowed || string(value) == "null" {
			return false
		}
		if key == "replace" {
			var v bool
			if json.Unmarshal(value, &v) != nil {
				return false
			}
			continue
		}
		var v string
		if json.Unmarshal(value, &v) != nil || len(v) > 256 {
			return false
		}
		if key == "token" && v == "" {
			return false
		}
		if key == "code" {
			if len(v) != 4 {
				return false
			}
			for _, c := range v {
				if c < '0' || c > '9' {
					return false
				}
			}
		}
	}
	return true
}

func isSignInPath(path string) bool {
	return strings.HasPrefix(path, "/api/accounts/signin-links") || strings.HasPrefix(path, "/api/accounts/signin-requests") || strings.HasPrefix(path, "/api/accounts/qr-signins")
}
