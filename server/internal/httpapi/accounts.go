package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

// accessCookie holds a browser's access pass, which signing in, registering
// and recovering require.
const accessCookie = "falky_access"

// accountProtection guards the access and account operations: their answers
// are never cached, and changes need the exact origin, a JSON object body and
// stay within the per-client attempt limit.
func accountProtection(next http.Handler, origin string, limit *platform.Limiter) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/access" || strings.HasPrefix(r.URL.Path, "/api/accounts/") {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Pragma", "no-cache")
			if r.Method != http.MethodGet {
				if r.Header.Get("Origin") != origin {
					writeError(w, 403, "origin_forbidden", "account operations require this server's exact origin")
					return
				}
				if !limit.Allow(clientIP(r)) {
					writeError(w, 429, "rate_limited", "too many account attempts; try again later")
					return
				}
				media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
				if err != nil || media != "application/json" {
					writeError(w, 400, "invalid_request", "account requests require application/json")
					return
				}
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
				if err != nil {
					writeError(w, 413, "invalid_request", "account request exceeds the body limit")
					return
				}
				trimmed := bytes.TrimSpace(raw)
				if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(raw) {
					writeError(w, 400, "invalid_request", "account requests require one JSON object")
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(raw))
			}
		}
		next.ServeHTTP(w, r)
	})
}

func accountHTTP(ctx context.Context) (*http.Request, http.ResponseWriter) {
	return ctx.Value(requestKey{}).(*http.Request), ctx.Value(writerKey{}).(http.ResponseWriter)
}

func accountToken(ctx context.Context) string { r, _ := accountHTTP(ctx); return sessionToken(r) }

func accessToken(ctx context.Context) string {
	r, _ := accountHTTP(ctx)
	if c, err := r.Cookie(accessCookie); err == nil {
		return c.Value
	}
	return ""
}

// accountError answers err, when there is one, and reports whether it did.
func (s *server) accountError(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	_, w := accountHTTP(ctx)
	switch {
	case errors.Is(err, identity.ErrNoVisitor):
		writeError(w, 401, visitorRequired.Code, visitorRequired.Message)
	case errors.Is(err, identity.ErrAccessRequired):
		writeError(w, 403, "access_required", "give the access password first")
	case errors.Is(err, identity.ErrAccessUnset):
		writeError(w, 503, "access_unset", "the server owner has not set the access password yet")
	case errors.Is(err, identity.ErrWrongAccessPassword):
		writeError(w, 403, "invalid_access_password", "the access password is wrong")
	case errors.Is(err, identity.ErrWrongCredentials):
		r, _ := accountHTTP(ctx)
		status := 401
		if r.URL.Path != "/api/accounts/login" {
			status = 403
		}
		writeError(w, status, "invalid_credentials", "the login or password is wrong")
	case errors.Is(err, identity.ErrDisabled):
		writeError(w, 403, "account_disabled", "this account is disabled; ask the server owner")
	case errors.Is(err, identity.ErrInvalidProof):
		writeError(w, 403, "invalid_proof", "the account or recovery code does not match")
	case errors.Is(err, identity.ErrInvalidLogin):
		writeError(w, 400, "invalid_login", err.Error())
	case errors.Is(err, identity.ErrLoginRequired):
		writeError(w, 400, "login_required", err.Error())
	case errors.Is(err, identity.ErrInvalidPassword):
		writeError(w, 400, "invalid_password", err.Error())
	case errors.Is(err, identity.ErrInvalidName):
		writeError(w, 400, "invalid_name", err.Error())
	case errors.Is(err, identity.ErrLoginTaken):
		writeError(w, 409, "login_taken", "another account has this login")
	case errors.Is(err, identity.ErrNameTaken):
		writeError(w, 409, "name_taken", "another account has this name")
	default:
		r, _ := accountHTTP(ctx)
		errorWriter{logger: s.logger}.internal(w, r, err)
	}
	return true
}

func (s *server) sessionBody(session identity.Session) api.AccountSession {
	body := api.AccountSession{Visitor: s.visitorBody(session.Visitor), Kind: api.AccountSessionKind(session.Kind)}
	if !session.ExpiresAt.IsZero() {
		expiry := session.ExpiresAt
		body.ExpiresAt = &expiry
	}
	return body
}

func sessionCookie(token string) string {
	return (&http.Cookie{Name: cookieName, Value: token, Path: "/api", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: cookieMaxAge}).String()
}

// enrollment enforces e's effects and returns its body and session cookie.
func (s *server) enrollment(ctx context.Context, e identity.Enrollment) (api.AccountEnrollment, string) {
	if err := s.lifecycle.Apply(ctx, e.Effects); err != nil {
		// The account change is committed; its session must reach the browser.
		s.logger.ErrorContext(ctx, "committed enrollment enforcement failed", "error", err)
	}
	return api.AccountEnrollment{Session: s.sessionBody(e.Session)}, sessionCookie(e.Token)
}

func (s *server) access(ctx context.Context) (api.Access, error) {
	set, err := s.identity.AccessPasswordSet(ctx)
	if err != nil {
		return api.Access{}, err
	}
	passed, err := s.identity.AccessPassed(ctx, accessToken(ctx))
	if err != nil {
		return api.Access{}, err
	}
	body := api.Access{PasswordSet: set, Passed: passed}
	if guest, err := s.identity.LegacyGuest(ctx, accountToken(ctx)); err == nil {
		body.GuestName = guest.Name
	} else if !errors.Is(err, identity.ErrNoVisitor) {
		return api.Access{}, err
	}
	return body, nil
}

func (s *server) GetAccess(ctx context.Context, _ api.GetAccessRequestObject) (api.GetAccessResponseObject, error) {
	body, err := s.access(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetAccess200JSONResponse(body), nil
}

func (s *server) PassAccess(ctx context.Context, req api.PassAccessRequestObject) (api.PassAccessResponseObject, error) {
	token, err := s.identity.PassAccess(ctx, req.Body.Password)
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, err := s.access(ctx)
	if err != nil {
		return nil, err
	}
	body.Passed = true
	cookie := &http.Cookie{Name: accessCookie, Value: token, Path: "/api", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: int(identity.AccessPassTTL / time.Second)}
	return api.PassAccess200JSONResponse{Body: body, Headers: api.PassAccess200ResponseHeaders{SetCookie: cookie.String()}}, nil
}

func (s *server) Register(ctx context.Context, req api.RegisterRequestObject) (api.RegisterResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	e, err := s.identity.Register(ctx, identity.RegistrationInput{
		AccessToken: accessToken(ctx), GuestToken: accountToken(ctx),
		Login: req.Body.Login, Password: req.Body.Password, Name: req.Body.Name,
	})
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, cookie := s.enrollment(ctx, e)
	return api.Register200JSONResponse{Body: body, Headers: api.Register200ResponseHeaders{SetCookie: cookie}}, nil
}

func (s *server) Login(ctx context.Context, req api.LoginRequestObject) (api.LoginResponseObject, error) {
	if s.loginLimit != nil && !s.loginLimit.Allow(strings.ToLower(strings.TrimSpace(req.Body.Login))) {
		return api.Login429JSONResponse{RateLimitedJSONResponse: api.RateLimitedJSONResponse{Code: "rate_limited", Message: "too many attempts for this login; try again later"}}, nil
	}
	e, err := s.identity.Login(ctx, accessToken(ctx), req.Body.Login, req.Body.Password)
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, cookie := s.enrollment(ctx, e)
	return api.Login200JSONResponse{Body: body, Headers: api.Login200ResponseHeaders{SetCookie: cookie}}, nil
}

func (s *server) Recover(ctx context.Context, req api.RecoverRequestObject) (api.RecoverResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	e, err := s.identity.Recover(ctx, identity.RecoveryInput{
		AccessToken: accessToken(ctx), Account: req.Body.Account, Proof: req.Body.Proof,
		Password: req.Body.Password, Login: req.Body.Login,
	})
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, cookie := s.enrollment(ctx, e)
	return api.Recover200JSONResponse{Body: body, Headers: api.Recover200ResponseHeaders{SetCookie: cookie}}, nil
}

func (s *server) ChangePassword(ctx context.Context, req api.ChangePasswordRequestObject) (api.ChangePasswordResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	effects, err := s.identity.ChangePassword(ctx, accountToken(ctx), req.Body.CurrentPassword, req.Body.NewPassword)
	if s.accountError(ctx, err) {
		return nil, nil
	}
	if err := s.lifecycle.Apply(ctx, effects); err != nil {
		return nil, err
	}
	return api.ChangePassword200JSONResponse{}, nil
}

func (s *server) GetAccountSession(ctx context.Context, _ api.GetAccountSessionRequestObject) (api.GetAccountSessionResponseObject, error) {
	return api.GetAccountSession200JSONResponse(s.sessionBody(currentSession(ctx))), nil
}

func (s *server) Logout(ctx context.Context, _ api.LogoutRequestObject) (api.LogoutResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	effects, err := s.identity.Logout(ctx, accountToken(ctx))
	if s.accountError(ctx, err) {
		return nil, nil
	}
	if err := s.lifecycle.Apply(ctx, effects); err != nil {
		return nil, err
	}
	cookie := (&http.Cookie{Name: cookieName, Path: "/api", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1}).String()
	return api.Logout200JSONResponse{Body: api.AccountEmpty{}, Headers: api.Logout200ResponseHeaders{SetCookie: cookie}}, nil
}
