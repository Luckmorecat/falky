package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/livekit/protocol/auth"

	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/voice"
)

func restartVoice(t *testing.T, p publicServer) publicServer {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	t.Cleanup(upstream.Close)
	p.voice = voice.New(p.livekit, p.identity, p.rooms, voice.Config{URL: testLiveKitURL, APIKey: testLiveKitKey, APISecret: testLiveKitSecret, RoomCap: testRoomCap}, voice.WithDB(p.db))
	p.lifecycle = &Lifecycle{}
	handlers := New(Deps{Identity: p.identity, Voice: p.voice, Rooms: p.rooms, Live: p.events.Hub, Logger: p.events.Logger, Lifecycle: p.lifecycle, PublicOrigin: testOrigin, LiveKitAPIURL: upstream.URL, Metrics: platform.NewMetrics().Handler(), EnterLimit: platform.NewLimiter(100, time.Hour, time.Now)})
	p.srv = httptest.NewTLSServer(handlers.Public)
	t.Cleanup(p.srv.Close)
	return p
}

func checkVoiceValidation(t *testing.T, p publicServer, token string, want int) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, p.srv.URL+"/rtc/validate?access_token="+url.QueryEscape(token), nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := p.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != want {
		t.Fatalf("RTC validation after restart = %d, want %d", res.StatusCode, want)
	}
}

func TestCurrentGuestVoiceJWTStillValidAfterBackendRestart(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Voice")
	client := p.browser(t)
	p.enter(t, client, "Guest")
	creds := joinedVoice(t, client, room.ID)
	p = restartVoice(t, p)
	checkVoiceValidation(t, p, creds.Token, http.StatusOK)
}

func TestGuestVoiceRestartCannotRestoreRevokedOrUpgradedGuest(t *testing.T) {
	for _, change := range []string{"logout", "rotation", "upgrade"} {
		t.Run(change, func(t *testing.T) {
			p := startPublic(t, 100)
			room := p.createRoom(t, "Voice")
			client, browser := p.browserWithHTTP(t)
			p.enter(t, client, "Guest")
			creds := joinedVoice(t, client, room.ID)
			p = restartVoice(t, p)
			switch change {
			case "logout":
				accountRequest(t, p, browser, "POST", "/api/accounts/logout", map[string]any{}, testOrigin, 200)
			case "rotation":
				if _, err := p.adminClient(t).RotateLink(t.Context()); err != nil {
					t.Fatal(err)
				}
			case "upgrade":
				enrollAccount(t, p, browser, "Guest", passkeytest.New(t))
				// Neither the old bare transport nor a fresh nonce-bearing
				// account token can use guest restoration after another restart.
				raw, _ := accountRequest(t, p, browser, "POST", "/api/rooms/"+room.ID+"/voice", nil, testOrigin, 200)
				var account api.VoiceCredentials
				if err := json.Unmarshal(raw, &account); err != nil {
					t.Fatal(err)
				}
				p = restartVoice(t, p)
				checkVoiceValidation(t, p, account.Token, 200)
			}
			checkVoiceValidation(t, p, creds.Token, 403)
		})
	}
}

func TestRestoredGuestConnectionsKeepBothRoomsAndNameAuthorization(t *testing.T) {
	p := startPublic(t, 100)
	first, second := p.createRoom(t, "First"), p.createRoom(t, "Second")
	client, browser := p.browserWithHTTP(t)
	p.enter(t, client, "Guest")
	old := joinedVoice(t, client, first.ID)
	p = restartVoice(t, p)
	raw, _ := accountRequest(t, p, browser, "POST", "/api/rooms/"+second.ID+"/voice", nil, "", 200)
	var current api.VoiceCredentials
	if err := json.Unmarshal(raw, &current); err != nil {
		t.Fatal(err)
	}
	checkVoiceValidation(t, p, old.Token, 200)
	checkVoiceValidation(t, p, current.Token, 200)
	// Restart retains each independently authorized room.
	p = restartVoice(t, p)
	checkVoiceValidation(t, p, current.Token, 200)
	checkVoiceValidation(t, p, old.Token, 200)
	p = restartVoice(t, p)
	p.clock.Advance(2 * time.Minute)
	other, otherHTTP := p.browserWithHTTP(t)
	p.enter(t, other, "Guest")
	p.connectLive(t, otherHTTP)
	checkVoiceValidation(t, p, current.Token, 403)
}

func TestGuestRestorationStillRequiresVerifiedSignerSignatureAndRoom(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Voice")
	client := p.browser(t)
	guest := p.enter(t, client, "Guest")
	valid := joinedVoice(t, client, room.ID)
	p = restartVoice(t, p)
	for _, invalid := range []struct{ key, secret, room string }{{"wrong-key", testLiveKitSecret, room.ID}, {testLiveKitKey, "wrong-secret", room.ID}, {testLiveKitKey, testLiveKitSecret, "unknown-room"}} {
		token, err := auth.NewAccessToken(invalid.key, invalid.secret).SetIdentity(guest.Id).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: invalid.room}).ToJWT()
		if err != nil {
			t.Fatal(err)
		}
		checkVoiceValidation(t, p, token, 403)
	}
	checkVoiceValidation(t, p, valid.Token, 200)
}

func TestGuestHTTPJoinsPreserveOrdinaryAndRestoredGrants(t *testing.T) {
	for _, restored := range []bool{false, true} {
		t.Run(fmt.Sprintf("restored=%t", restored), func(t *testing.T) {
			p := startPublic(t, 100)
			first, second, third := p.createRoom(t, "First"), p.createRoom(t, "Second"), p.createRoom(t, "Third")
			client, browser := p.browserWithHTTP(t)
			p.enter(t, client, "Guest")
			old := joinedVoice(t, client, first.ID)
			if restored {
				p = restartVoice(t, p)
				checkVoiceValidation(t, p, old.Token, 200)
			} else {
				// Add the same test upstream without replacing the ordinary grant.
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
				t.Cleanup(upstream.Close)
				guard := httptest.NewTLSServer(p.voice.Signalling(upstream.URL))
				t.Cleanup(guard.Close)
				p.internal = guard
			}
			validation := p
			if !restored {
				validation.srv = p.internal
			}
			p.livekit.AddParticipant(first.ID, old.GrantId)
			join := func(room string) api.VoiceCredentials {
				raw, _ := accountRequest(t, p, browser, "POST", "/api/rooms/"+room+"/voice", nil, "", 200)
				var credentials api.VoiceCredentials
				if err := json.Unmarshal(raw, &credentials); err != nil {
					t.Fatal(err)
				}
				return credentials
			}
			current := join(second.ID)
			if got := p.livekit.Removed(); len(got) != 0 {
				t.Fatalf("independent Join removed old media: %v", got)
			}
			assert := func(token string, valid bool) {
				for _, path := range []string{"/rtc", "/rtc/v1", "/rtc/validate", "/rtc/v1/validate"} {
					want := 403
					if valid {
						want = 200
						if path == "/rtc" || path == "/rtc/v1" {
							want = 400
						}
					}
					req, err := http.NewRequestWithContext(t.Context(), "GET", validation.srv.URL+path+"?access_token="+url.QueryEscape(token), nil)
					if err != nil {
						t.Fatal(err)
					}
					res, err := validation.srv.Client().Do(req)
					if err != nil {
						t.Fatal(err)
					}
					_ = res.Body.Close()
					if res.StatusCode != want {
						t.Fatalf("room JWT at %s = %d, want %d", path, res.StatusCode, want)
					}
				}
			}
			assert(old.Token, true)
			assert(current.Token, true)
			p.livekit.AddParticipant(second.ID, current.GrantId)
			sameRoom := join(second.ID)
			assert(current.Token, true)
			assert(sameRoom.Token, true)
			if got := p.livekit.Removed(); len(got) != 0 {
				t.Fatal("same-room guest join removed independent media")
			}
			newest := join(third.ID)
			assert(old.Token, true)
			assert(current.Token, true)
			assert(newest.Token, true)
		})
	}
}

func TestGuestExplicitJoinRetainsPersistedRoomBinding(t *testing.T) {
	p := startPublic(t, 100)
	first, second := p.createRoom(t, "First"), p.createRoom(t, "Second")
	client := p.browser(t)
	guest := p.enter(t, client, "Guest")
	old := joinedVoice(t, client, first.ID)
	p = restartVoice(t, p)
	checkVoiceValidation(t, p, old.Token, 200)
	session, err := p.identity.GuestSession(t.Context(), guest.Id)
	if err != nil {
		t.Fatal(err)
	}
	p.lifecycle.Lock()
	current, err := p.voice.JoinSession(t.Context(), session, second.ID)
	p.lifecycle.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	checkVoiceValidation(t, p, old.Token, 200)
	checkVoiceValidation(t, p, current.Token, 200)
}
