//go:build integration

package voice_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/kisshot/falky/server/internal/httpapi"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
)

func TestSignedHTTPRecoveryEndsRealMediaAndPreservesNewLiveAndVoiceSession(t *testing.T) {
	const origin = "https://falky.example"
	logger := platform.NewLogger(io.Discard, 0)
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "http-voice.db"), logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	migrations, err := platform.LoadMigrations(identity.Migrations(), rooms.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(t.Context(), migrations); err != nil {
		t.Fatal(err)
	}
	ident := identity.New(db, origin)
	hub := realtime.New()
	events := httpapi.Events{Hub: hub, Logger: logger}
	rs := rooms.New(db, rooms.WithPublisher(events.RoomChanged))
	room, err := rs.Create(t.Context(), "HTTP recovery")
	if err != nil {
		t.Fatal(err)
	}
	vs := voice.New(liveKitClient(), ident, rs, voice.Config{APIKey: devKey, APISecret: devSecret, RoomCap: 8}, voice.WithPublisher(events.OccupancyChanged))
	gate := &httpapi.Lifecycle{Enforce: httpapi.Enforcer(events, vs)}
	handlers := httpapi.New(httpapi.Deps{
		Logger: logger, Identity: ident, Rooms: rs, Voice: vs, Live: hub, Metrics: platform.NewMetrics().Handler(),
		Lifecycle: gate, PublicOrigin: origin,
		LiveKitAPIURL: fmt.Sprintf("http://127.0.0.1:%d", liveKitPort),
	})
	public := httptest.NewTLSServer(handlers.Public)
	guard := httptest.NewServer(handlers.Signalling)
	t.Cleanup(func() { vs.CloseSignalling(); public.Close(); guard.Close() })
	newBrowser := func() *http.Client {
		jar, err := cookiejar.New(nil)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Client{Transport: public.Client().Transport, Jar: jar}
	}
	request := func(browser *http.Client, method, path string, input, output any, want int) {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(t.Context(), method, public.URL+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		res, err := browser.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode != want {
			t.Fatalf("%s %s = %d, want %d", method, path, res.StatusCode, want)
		}
		if output != nil {
			if err := json.NewDecoder(res.Body).Decode(output); err != nil {
				t.Fatal(err)
			}
		}
	}
	type ceremony struct {
		ID      string                      `json:"id"`
		Options protocol.CredentialCreation `json:"options"`
	}
	type enrollment struct {
		Session struct {
			Visitor struct{ ID string } `json:"visitor"`
		} `json:"session"`
		Codes []string `json:"recoveryCodes"`
	}
	finish := func(browser *http.Client, purpose string, begin ceremony) enrollment {
		t.Helper()
		key := passkeytest.New(t)
		var result enrollment
		request(browser, "POST", "/api/accounts/"+purpose+"/finish", map[string]any{
			"ceremonyId": begin.ID, "credential": json.RawMessage(key.Registration(t, &begin.Options, origin)),
		}, &result, 200)
		return result
	}
	openLive := func(browser *http.Client) *websocket.Conn {
		t.Helper()
		ws, res, err := websocket.Dial(t.Context(), public.URL+"/api/live", &websocket.DialOptions{HTTPClient: browser, HTTPHeader: http.Header{"Origin": {origin}}})
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ws.CloseNow() })
		return ws
	}
	join := func(browser *http.Client) voice.Credentials {
		t.Helper()
		var credentials voice.Credentials
		request(browser, "POST", "/api/rooms/"+room.ID+"/voice", map[string]any{}, &credentials, 200)
		if credentials.URL != "wss://falky.example" {
			t.Fatal("account credentials bypass public origin")
		}
		// The SDK reaches the same guard over loopback; WebAuthn keeps its configured RP origin.
		credentials.URL = "ws" + strings.TrimPrefix(guard.URL, "http")
		return credentials
	}
	invite, err := ident.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	first := newBrowser()
	var begin ceremony
	request(first, "POST", "/api/accounts/registration/begin", map[string]any{"invitation": invite.Token, "name": "Account"}, &begin, 200)
	account := finish(first, "registration", begin)
	oldLive := openLive(first)
	oldCredentials := join(first)
	oldMedia := connect(t, oldCredentials)
	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = track.Close() }()
	if _, err := oldMedia.room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Source: livekit.TrackSource_MICROPHONE}); err != nil {
		t.Fatal(err)
	}
	if err := track.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}, nil); err != nil {
		t.Fatal(err)
	}
	recovering := newBrowser()
	request(recovering, "POST", "/api/accounts/recovery/begin", map[string]any{"accountId": account.Session.Visitor.ID, "proof": account.Codes[0]}, &begin, 200)
	recovered := finish(recovering, "recovery", begin)
	if recovered.Session.Visitor.ID != account.Session.Visitor.ID || len(recovered.Codes) != 1 {
		t.Fatal("recovery changed identity or omitted replacement codes")
	}
	select {
	case <-oldMedia.disconnected:
	case <-time.After(2 * time.Second):
		t.Fatal("successful HTTP recovery left old real media connected")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	if _, _, err := oldLive.Read(ctx); websocket.CloseStatus(err) != realtime.StatusRevoked {
		t.Fatalf("old live session survived HTTP recovery: %v", err)
	}
	request(first, "GET", "/api/me", nil, nil, 401)
	request(recovering, "GET", "/api/me", nil, nil, 200)
	refusedAtGuard(t, guardedVoice{public: guard}, oldCredentials.Token)
	freshLive := openLive(recovering)
	if _, err := rs.Create(t.Context(), "Recovered session works"); err != nil {
		t.Fatal(err)
	}
	if _, event, err := freshLive.Read(ctx); err != nil || !bytes.Contains(event, []byte("room.changed")) {
		t.Fatalf("fresh live session lost after recovery: %v", err)
	}
	freshMedia := connect(t, join(recovering))
	waitForParticipants(t, liveKitClient(), room.ID, freshMedia.room.LocalParticipant.Identity())
	if err := vs.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	if occupancy := vs.Occupancy(room.ID); len(occupancy) != 1 || occupancy[0].ID != account.Session.Visitor.ID {
		t.Fatal("recovered media lost permanent identity")
	}
}
