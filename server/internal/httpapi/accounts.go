package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

const ceremonyCookie = "__Host-falky-ceremony"

func accountProtection(next http.Handler, origin string, limit *platform.Limiter, signIns *SignInLimits) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/accounts/") {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Pragma", "no-cache")
			if r.Method != http.MethodGet {
				if r.Header.Get("Origin") != origin {
					writeError(w, 403, "origin_forbidden", "account operations require this server's exact origin")
					return
				}
				attempts := limit
				wait := 3 * time.Second
				if r.URL.Path == "/api/accounts/signin-requests" && r.Method == http.MethodPost {
					attempts = signIns.LinkAttempts
				}
				if r.URL.Path == "/api/accounts/qr-signins" && r.Method == http.MethodPost {
					attempts = signIns.QRAttempts
				}
				if !attempts.Allow(clientIP(r)) {
					w.Header().Set("Retry-After", strconv.Itoa(int(wait/time.Second)))
					writeError(w, 429, "rate_limited", "too many account attempts; try again later")
					return
				}
				if r.Method == http.MethodPost {
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
					if isSignInPath(r.URL.Path) && !validateSignInBody(r.URL.Path, raw) {
						writeError(w, 400, "invalid_request", "sign-in body does not match the operation")
						return
					}
					r.Body = io.NopCloser(bytes.NewReader(raw))
				}

			}
		}
		next.ServeHTTP(w, r)
	})
}

func accountHTTP(ctx context.Context) (*http.Request, http.ResponseWriter) {
	return ctx.Value(requestKey{}).(*http.Request), ctx.Value(writerKey{}).(http.ResponseWriter)
}

func browserContext(ctx context.Context, begin bool) string {
	r, w := accountHTTP(ctx)
	var value string
	if c, err := r.Cookie(ceremonyCookie); err == nil && len(c.Value) == 52 {
		value = c.Value
	}
	if !begin {
		return value
	}
	if value == "" {
		value = rand.Text() + rand.Text()
	}
	http.SetCookie(w, &http.Cookie{Name: ceremonyCookie, Value: value, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 600})
	return value
}

func (s *server) accountError(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	_, w := accountHTTP(ctx)
	switch {
	case errors.Is(err, identity.ErrNoVisitor):
		writeError(w, 401, "visitor_required", "a valid account session is required")
	case errors.Is(err, identity.ErrInvalidName):
		writeError(w, 400, "invalid_name", err.Error())
	case errors.Is(err, identity.ErrNameTaken):
		writeError(w, 409, "name_taken", "an account already reserves this name")
	case errors.Is(err, identity.ErrRecentProof):
		writeError(w, 403, "recent_proof_required", "verify a passkey in this session first")
	case errors.Is(err, identity.ErrLastPasskey):
		writeError(w, 409, "last_passkey", "the last passkey cannot be removed")
	case errors.Is(err, identity.ErrCredentialExists):
		writeError(w, 409, "credential_exists", "credential cannot be enrolled")
	case errors.Is(err, identity.ErrDisabled), errors.Is(err, identity.ErrInvalidProof):
		writeError(w, 403, "invalid_proof", "the account proof is invalid or expired")
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

func passkeyBody(p identity.Passkey) api.AccountPasskey {
	return api.AccountPasskey{Id: p.ID, Label: p.Label, CreatedAt: p.CreatedAt}
}

func ceremonyBody(c identity.Ceremony) (api.AccountCeremony, error) {
	var options any = c.Creation
	if c.Assertion != nil {
		options = c.Assertion
	}
	raw, err := json.Marshal(options)
	if err != nil {
		return api.AccountCeremony{}, err
	}
	var result map[string]interface{}
	err = json.Unmarshal(raw, &result)
	return api.AccountCeremony{Id: c.ID, ExpiresAt: c.ExpiresAt, Options: result}, err
}
func accountToken(ctx context.Context) string { r, _ := accountHTTP(ctx); return sessionToken(r) }
func credentialBody(body *api.AccountFinish) []byte {
	raw, _ := json.Marshal(body.Credential)
	return raw
}

func (s *server) enrollment(ctx context.Context, e identity.Enrollment) (api.AccountEnrollment, string) {
	if err := s.lifecycle.Apply(ctx, e.Effects); err != nil {
		// Enrollment is committed and its one-time credentials cannot be regenerated.
		s.logger.ErrorContext(ctx, "committed enrollment enforcement failed", "error", err)
	}
	codes := e.RecoveryCodes
	if codes == nil {
		codes = []string{}
	}
	cookie := (&http.Cookie{Name: cookieName, Value: e.Token, Path: "/api", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 90 * 24 * 60 * 60}).String()
	return api.AccountEnrollment{Session: s.sessionBody(e.Session), RecoveryCodes: codes}, cookie
}

func (s *server) BeginRegistration(ctx context.Context, req api.BeginRegistrationRequestObject) (api.BeginRegistrationResponseObject, error) {
	guest := ""
	if session, err := s.identity.ResolveSession(ctx, accountToken(ctx)); err == nil && session.Kind == identity.Guest {
		guest = accountToken(ctx)
	}
	c, err := s.identity.BeginRegistration(ctx, identity.RegistrationInput{Invitation: req.Body.Invitation, Name: req.Body.Name, GuestToken: guest, BrowserContext: browserContext(ctx, true)})
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, err := ceremonyBody(c)
	_, w := accountHTTP(ctx)
	return api.BeginRegistration200JSONResponse{Body: body, Headers: api.BeginRegistration200ResponseHeaders{SetCookie: w.Header().Get("Set-Cookie")}}, err
}

func (s *server) BeginAuthentication(ctx context.Context, req api.BeginAuthenticationRequestObject) (api.BeginAuthenticationResponseObject, error) {
	c, err := s.identity.BeginAuthentication(ctx, browserContext(ctx, true))
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, err := ceremonyBody(c)
	_, w := accountHTTP(ctx)
	return api.BeginAuthentication200JSONResponse{Body: body, Headers: api.BeginAuthentication200ResponseHeaders{SetCookie: w.Header().Get("Set-Cookie")}}, err
}

func (s *server) BeginReauthentication(ctx context.Context, req api.BeginReauthenticationRequestObject) (api.BeginReauthenticationResponseObject, error) {
	c, err := s.identity.BeginReauthentication(ctx, accountToken(ctx), browserContext(ctx, true))
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, err := ceremonyBody(c)
	_, w := accountHTTP(ctx)
	return api.BeginReauthentication200JSONResponse{Body: body, Headers: api.BeginReauthentication200ResponseHeaders{SetCookie: w.Header().Get("Set-Cookie")}}, err
}

func (s *server) BeginAddPasskey(ctx context.Context, req api.BeginAddPasskeyRequestObject) (api.BeginAddPasskeyResponseObject, error) {
	c, err := s.identity.BeginAddPasskey(ctx, accountToken(ctx), browserContext(ctx, true))
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, err := ceremonyBody(c)
	_, w := accountHTTP(ctx)
	return api.BeginAddPasskey200JSONResponse{Body: body, Headers: api.BeginAddPasskey200ResponseHeaders{SetCookie: w.Header().Get("Set-Cookie")}}, err
}

func (s *server) BeginRecovery(ctx context.Context, req api.BeginRecoveryRequestObject) (api.BeginRecoveryResponseObject, error) {
	c, err := s.identity.BeginRecovery(ctx, req.Body.AccountId, req.Body.Proof, browserContext(ctx, true))
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, err := ceremonyBody(c)
	_, w := accountHTTP(ctx)
	return api.BeginRecovery200JSONResponse{Body: body, Headers: api.BeginRecovery200ResponseHeaders{SetCookie: w.Header().Get("Set-Cookie")}}, err
}

func (s *server) FinishRegistration(ctx context.Context, req api.FinishRegistrationRequestObject) (api.FinishRegistrationResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	e, err := s.identity.FinishRegistration(ctx, req.Body.CeremonyId, browserContext(ctx, false), credentialBody(req.Body), req.Body.Label)
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, cookie := s.enrollment(ctx, e)
	return api.FinishRegistration200JSONResponse{Body: body, Headers: api.FinishRegistration200ResponseHeaders{SetCookie: cookie}}, nil
}

func (s *server) FinishAuthentication(ctx context.Context, req api.FinishAuthenticationRequestObject) (api.FinishAuthenticationResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	e, err := s.identity.FinishAuthentication(ctx, req.Body.CeremonyId, browserContext(ctx, false), credentialBody(req.Body))
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, cookie := s.enrollment(ctx, e)
	return api.FinishAuthentication200JSONResponse{Body: body, Headers: api.FinishAuthentication200ResponseHeaders{SetCookie: cookie}}, nil
}

func (s *server) FinishRecovery(ctx context.Context, req api.FinishRecoveryRequestObject) (api.FinishRecoveryResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	e, err := s.identity.FinishRecovery(ctx, req.Body.CeremonyId, browserContext(ctx, false), credentialBody(req.Body), req.Body.Label)
	if s.accountError(ctx, err) {
		return nil, nil
	}
	body, cookie := s.enrollment(ctx, e)
	return api.FinishRecovery200JSONResponse{Body: body, Headers: api.FinishRecovery200ResponseHeaders{SetCookie: cookie}}, nil
}

func (s *server) FinishReauthentication(ctx context.Context, req api.FinishReauthenticationRequestObject) (api.FinishReauthenticationResponseObject, error) {
	session, err := s.identity.FinishReauthentication(ctx, accountToken(ctx), req.Body.CeremonyId, browserContext(ctx, false), credentialBody(req.Body))
	if s.accountError(ctx, err) {
		return nil, nil
	}
	return api.FinishReauthentication200JSONResponse{Body: s.sessionBody(session)}, nil
}

func (s *server) FinishAddPasskey(ctx context.Context, req api.FinishAddPasskeyRequestObject) (api.FinishAddPasskeyResponseObject, error) {
	p, err := s.identity.FinishAddPasskey(ctx, accountToken(ctx), req.Body.CeremonyId, browserContext(ctx, false), credentialBody(req.Body), req.Body.Label)
	if s.accountError(ctx, err) {
		return nil, nil
	}
	return api.FinishAddPasskey200JSONResponse{Body: passkeyBody(p)}, nil
}

func (s *server) ListPasskeys(ctx context.Context, _ api.ListPasskeysRequestObject) (api.ListPasskeysResponseObject, error) {
	keys, err := s.identity.Passkeys(ctx, accountToken(ctx))
	if s.accountError(ctx, err) {
		return nil, nil
	}
	result := make([]api.AccountPasskey, 0, len(keys))
	for _, key := range keys {
		result = append(result, passkeyBody(key))
	}
	return api.ListPasskeys200JSONResponse{Passkeys: result}, nil
}

func (s *server) RemovePasskey(ctx context.Context, req api.RemovePasskeyRequestObject) (api.RemovePasskeyResponseObject, error) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	effects, err := s.identity.RemovePasskeyWithEffects(ctx, accountToken(ctx), req.CredentialId)
	if s.accountError(ctx, err) {
		return nil, nil
	}
	if err := s.lifecycle.Apply(ctx, effects); err != nil {
		return nil, err
	}
	return api.RemovePasskey200JSONResponse{}, nil
}

func (s *server) RegenerateRecoveryCodes(ctx context.Context, _ api.RegenerateRecoveryCodesRequestObject) (api.RegenerateRecoveryCodesResponseObject, error) {
	codes, err := s.identity.RegenerateRecoveryCodes(ctx, accountToken(ctx))
	if s.accountError(ctx, err) {
		return nil, nil
	}
	return api.RegenerateRecoveryCodes200JSONResponse{Body: api.RecoveryCodes{RecoveryCodes: codes}}, nil
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
