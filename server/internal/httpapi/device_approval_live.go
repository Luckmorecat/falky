package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/realtime"
)

type signInLive struct {
	origin    string
	identity  *identity.Service
	hub       *realtime.Hub
	lifecycle *Lifecycle
	logger    *slog.Logger
	limits    *SignInLimits
	now       func() time.Time
}

func (l signInLive) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != l.origin {
		writeError(w, 403, "origin_forbidden", "sign-in events require this server's exact origin")
		return
	}
	if !l.limits.CandidateAttempts.Allow(clientIP(r)) {
		signInRateLimited(w, 3*time.Second)
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		writeError(w, 400, "invalid_request", "not a WebSocket upgrade")
		return
	}
	l.lifecycle.Lock()
	locked := true
	defer func() {
		if locked {
			l.lifecycle.Unlock()
		}
	}()
	id, browser := r.PathValue("requestId"), signInBinding(r)
	view, err := l.identity.SignInRequest(r.Context(), id, browser)
	if errors.Is(err, identity.ErrInvalidProof) {
		writeError(w, 403, "invalid_proof", "the sign-in proof is invalid or expired")
		return
	}
	if err != nil {
		errorWriter{logger: l.logger}.internal(w, r, err)
		return
	}
	data, err := signInEventData(api.EventTypeAccountSigninStateChanged, view)
	if err != nil {
		errorWriter{logger: l.logger}.internal(w, r, err)
		return
	}
	l.hub.Serve(w, r, realtime.Subscriber{
		RequestID: id, CandidateIP: clientIP(r), Ticket: l.hub.Ticket(),
		Initial:  []realtime.Event{{RequestID: id, Data: data}},
		Deadline: time.Now().Add(view.ExpiresAt.Sub(l.now())), Terminal: signInTerminal(view.State),
		Registered: func() { locked = false; l.lifecycle.Unlock() },
		Authorized: func(ctx context.Context) bool {
			_, err := l.identity.SignInRequest(ctx, id, browser)
			return err == nil
		},
	})
}
func signInTerminal(state string) bool { return state == "denied" || state == "cancelled" }
func signInEventData(typ api.EventType, view identity.SignInRequestView) ([]byte, error) {
	return encodeEvent(typ, "", func(p *api.Event_Payload) error { return p.FromSignInRequest(signInRequestBody(view)) })
}

func (e Events) SignInChanged(change identity.SignInChange) {
	if e.Hub == nil {
		return
	}
	candidate, err := signInEventData(api.EventTypeAccountSigninStateChanged, change.Request)
	if err != nil {
		e.Logger.Error("sign-in hint not encoded", "error", err)
		return
	}
	if change.NotifyIssuer && change.IssuerSessionID != "" {
		issuer, err := signInEventData(api.EventTypeAccountSigninRequested, change.Request)
		if err != nil {
			e.Logger.Error("sign-in issuer hint not encoded", "error", err)
		} else {
			e.Hub.Publish(realtime.Event{SessionID: change.IssuerSessionID, Data: issuer})
		}
	}
	if signInTerminal(change.Request.State) {
		e.Hub.EndRequest(change.Request.ID, candidate)
	} else {
		e.Hub.Publish(realtime.Event{RequestID: change.Request.ID, Data: candidate})
	}
}
