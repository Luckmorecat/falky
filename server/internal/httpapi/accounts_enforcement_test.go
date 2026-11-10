package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/kisshot/falky/server/internal/realtime"
)

func TestCommittedEnrollmentReturnsCredentialsWhenVoiceCleanupFails(t *testing.T) {
	for _, purpose := range []string{"registration", "recovery"} {
		t.Run(purpose, func(t *testing.T) {
			p := startPublic(t, 100)
			client, browser := p.browserWithHTTP(t)
			oldKey := passkeytest.New(t)
			var account enrolledAccount
			var identityID string
			if purpose == "registration" {
				identityID = p.enter(t, client, "Guest").Id
			} else {
				account = enrollAccount(t, p, browser, "Account", oldKey)
				identityID = account.Session.Visitor.ID
			}
			target, err := url.Parse(p.srv.URL + "/api")
			if err != nil {
				t.Fatal(err)
			}
			var oldToken string
			for _, cookie := range browser.Jar.Cookies(target) {
				if cookie.Name == cookieName {
					oldToken = cookie.Value
				}
			}
			if _, err := p.identity.ResolveSession(t.Context(), oldToken); err != nil {
				t.Fatalf("original browser session is invalid: %v", err)
			}
			room := p.createRoom(t, "Voice")
			creds := joinedVoice(t, client, room.ID)
			participant := p.livekit.AddParticipant(room.ID, creds.GrantId)
			live := p.connectLive(t, browser)
			finishing := browser
			var ceremony wireCeremony
			if purpose == "registration" {
				invite, err := p.identity.CreateInvitation(t.Context())
				if err != nil {
					t.Fatal(err)
				}
				ceremony = beginAccount(t, p, finishing, "/api/accounts/registration/begin", map[string]any{"invitation": invite.Token, "name": "Account"})
			} else {
				_, finishing = p.browserWithHTTP(t)
				ceremony = beginAccount(t, p, finishing, "/api/accounts/recovery/begin", map[string]any{"accountId": identityID, "proof": account.RecoveryCodes[0]})
			}
			var options protocol.CredentialCreation
			if err := json.Unmarshal(ceremony.Options, &options); err != nil {
				t.Fatal(err)
			}
			key := passkeytest.New(t)
			finish := map[string]any{"ceremonyId": ceremony.ID, "credential": json.RawMessage(key.Registration(t, &options, testOrigin))}
			cleanupFailure := errors.New("LiveKit temporarily unavailable")
			p.livekit.Fail(cleanupFailure)
			raw, response := accountRequest(t, p, finishing, http.MethodPost, "/api/accounts/"+purpose+"/finish", finish, testOrigin, http.StatusOK)
			var result enrolledAccount
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			if result.Session.Visitor.ID != identityID || len(result.RecoveryCodes) != 1 || response.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("committed enrollment did not return its identity and private recovery codes")
			}
			var token string
			for _, cookie := range response.Cookies {
				if cookie.Name == cookieName {
					token = cookie.Value
				}
			}
			session, err := p.identity.ResolveSession(t.Context(), token)
			if err != nil || session.Kind != identity.Account || session.Visitor.ID != identityID {
				t.Fatalf("returned account cookie is invalid: %v", err)
			}
			if _, err := p.identity.ResolveSession(t.Context(), oldToken); !errors.Is(err, identity.ErrNoVisitor) {
				t.Fatalf("enrollment retained the previous browser session: %v", err)
			}
			readClosed(t, live, realtime.StatusRevoked)
			accountRequest(t, p, finishing, http.MethodGet, "/api/accounts/session", nil, "", http.StatusOK)
			accountRequest(t, p, finishing, http.MethodPost, "/api/accounts/"+purpose+"/finish", finish, testOrigin, http.StatusForbidden)
			if !strings.Contains(p.logs.String(), cleanupFailure.Error()) {
				t.Fatal("enforcement failure was not reported")
			}
			for _, secret := range append(result.RecoveryCodes, token, oldToken, creds.Token) {
				if strings.Contains(p.logs.String(), secret) {
					t.Fatal("credential leaked in enforcement logs")
				}
			}
			p = restartVoice(t, p)
			checkVoiceValidation(t, p, creds.Token, http.StatusForbidden)
			p.livekit.Fail(nil)
			listed, err := p.livekit.Participants(t.Context())
			if err != nil || len(listed) != 1 || listed[0] != participant {
				t.Fatalf("failed media cleanup was lost: %v, %v", listed, err)
			}
			if err := p.lifecycle.Maintain(t.Context(), p.events.Hub, p.voice); err != nil {
				t.Fatal(err)
			}
			if listed, err := p.livekit.Participants(t.Context()); err != nil || len(listed) != 0 {
				t.Fatalf("maintenance did not retry pending media cleanup: %v, %v", listed, err)
			}
			loginAccountBrowser(t, p, key)
			if purpose == "recovery" {
				accountRequest(t, p, finishing, http.MethodPost, "/api/accounts/recovery/begin", map[string]any{"accountId": identityID, "proof": account.RecoveryCodes[0]}, testOrigin, http.StatusForbidden)
				_, stale := p.browserWithHTTP(t)
				login := beginAccount(t, p, stale, "/api/accounts/authentication/begin", map[string]any{})
				var assertion protocol.CredentialAssertion
				if err := json.Unmarshal(login.Options, &assertion); err != nil {
					t.Fatal(err)
				}
				accountRequest(t, p, stale, http.MethodPost, "/api/accounts/authentication/finish", map[string]any{"ceremonyId": login.ID, "credential": json.RawMessage(oldKey.Assertion(t, &assertion, testOrigin))}, testOrigin, http.StatusForbidden)
			}
			beginAccount(t, p, finishing, "/api/accounts/recovery/begin", map[string]any{"accountId": identityID, "proof": result.RecoveryCodes[0]})
		})
	}
}
