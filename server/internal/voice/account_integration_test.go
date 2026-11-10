//go:build integration

package voice_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"google.golang.org/protobuf/proto"

	"github.com/kisshot/falky/server/internal/httpapi"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
)

type guardedVoice struct {
	db     *platform.DB
	ident  *identity.Service
	voice  *voice.Service
	gate   *httpapi.Lifecycle
	public *httptest.Server
	room   string
	rooms  *rooms.Service
}

func newGuardedVoice(t *testing.T, options ...identity.Option) guardedVoice {
	t.Helper()
	return newGuardedVoiceWithOptions(t, nil, options...)
}

func newGuardedVoiceWithOptions(t *testing.T, voiceOptions []voice.Option, options ...identity.Option) guardedVoice {
	t.Helper()
	logger := platform.NewLogger(io.Discard, 0)
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "voice.db"), logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	migrations, err := platform.LoadMigrations(identity.Migrations(), rooms.Migrations(), voice.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(t.Context(), migrations); err != nil {
		t.Fatal(err)
	}
	ident := identity.New(db, "https://falky.example", append([]identity.Option{identity.WithPasswordCost(identity.PasswordCost{Time: 1, MemoryKiB: 64})}, options...)...)
	rs := rooms.New(db)
	room, err := rs.Create(t.Context(), "Voice")
	if err != nil {
		t.Fatal(err)
	}
	s := voice.New(liveKitClient(), ident, rs, voice.Config{URL: "wss://must-not-bypass.invalid", APIKey: devKey, APISecret: devSecret, RoomCap: 8}, append(voiceOptions, voice.WithDB(db))...)
	gate := &httpapi.Lifecycle{Enforce: httpapi.Enforcer(httpapi.Events{}, s)}
	public := httptest.NewServer(s.Signalling(fmt.Sprintf("http://127.0.0.1:%d", liveKitPort)))
	s.ConfigureAdmission(gate, ident.ValidateSession, public.URL)
	t.Cleanup(func() { s.CloseSignalling(); public.Close() })
	return guardedVoice{db: db, ident: ident, voice: s, gate: gate, public: public, room: room.ID, rooms: rs}
}

// enroll registers an account and returns it with its login.
func (f guardedVoice) enroll(t *testing.T) (identity.Enrollment, string) {
	t.Helper()
	return registerAccount(t, f.ident)
}

// login signs login in again.
func (f guardedVoice) login(t *testing.T, login string) identity.Enrollment {
	t.Helper()
	return signIn(t, f.ident, login)
}

func (f guardedVoice) join(t *testing.T, session identity.Session) voice.Credentials {
	t.Helper()
	f.gate.Lock()
	defer f.gate.Unlock()
	c, err := f.voice.JoinSession(t.Context(), session, f.room)
	if err != nil {
		t.Fatal(err)
	}
	if session.Kind == identity.Account && c.URL != "ws"+strings.TrimPrefix(f.public.URL, "http") {
		t.Fatal("account credentials bypass guarded public URL")
	}
	return c
}

func refusedAtGuard(t *testing.T, f guardedVoice, token string) {
	t.Helper()
	for _, path := range []string{"/rtc", "/rtc/v1", "/rtc/validate", "/rtc/v1/validate"} {
		req, err := http.NewRequestWithContext(t.Context(), "GET", f.public.URL+path+"?access_token="+url.QueryEscape(token), nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != 403 || res.Header.Get("X-Falky-RTC-Guard") != "1" {
			t.Fatalf("stale grant at %s = %d", path, res.StatusCode)
		}
	}
}

func TestGuardedLiveKitIndependentMediaDisconnectReconnectLogoutRecoveryAndDisable(t *testing.T) {
	f := newGuardedVoice(t)
	account, key := f.enroll(t)
	second := f.login(t, key)
	one, two, three := f.join(t, account.Session), f.join(t, account.Session), f.join(t, second.Session)
	firstClient, secondClient, thirdClient := connect(t, one), connect(t, two), connect(t, three)
	publish := func(client voiceClient, mime string, source livekit.TrackSource, data []byte) {
		track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: mime})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = track.Close() })
		publication, err := client.room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: source.String(), Source: source})
		if err != nil || publication.SID() == "" {
			t.Fatalf("publish %s: %v", source, err)
		}
		sending, stop := context.WithCancel(t.Context())
		done := make(chan error, 1)
		go func() {
			ticker := time.NewTicker(20 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-sending.Done():
					done <- nil
					return
				case <-ticker.C:
					if err := track.WriteSample(media.Sample{Data: data, Duration: 20 * time.Millisecond}, nil); err != nil {
						done <- err
						return
					}
				}
			}
		}()
		t.Cleanup(func() {
			stop()
			if err := <-done; err != nil {
				t.Errorf("write media: %v", err)
			}
		})
	}
	publish(firstClient, webrtc.MimeTypeOpus, livekit.TrackSource_MICROPHONE, []byte{0xf8, 0xff, 0xfe})
	publish(secondClient, webrtc.MimeTypeVP8, livekit.TrackSource_SCREEN_SHARE, []byte{0x10, 0x00})
	publish(thirdClient, webrtc.MimeTypeVP8, livekit.TrackSource_CAMERA, []byte{0x10, 0x00})
	api := lksdk.NewRoomServiceClient(fmt.Sprintf("http://127.0.0.1:%d", liveKitPort), devKey, devSecret)
	for _, expected := range []struct {
		grant  string
		source livekit.TrackSource
	}{{one.GrantID, livekit.TrackSource_MICROPHONE}, {two.GrantID, livekit.TrackSource_SCREEN_SHARE}, {three.GrantID, livekit.TrackSource_CAMERA}} {
		var participant *livekit.ParticipantInfo
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			var err error
			participant, err = api.GetParticipant(t.Context(), &livekit.RoomParticipantIdentity{Room: f.room, Identity: expected.grant})
			if err != nil {
				t.Fatal(err)
			}
			if len(participant.Tracks) == 1 && participant.Tracks[0].Source == expected.source {
				break
			}
		}
		if len(participant.Tracks) != 1 || participant.Tracks[0].Source != expected.source {
			t.Fatalf("independent publication for %s: %v", expected.grant, participant.Tracks)
		}
	}
	if err := f.voice.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	occupants := f.voice.Occupancy(f.room)
	if len(occupants) != 3 {
		t.Fatalf("connection occupancy = %v", occupants)
	}
	for _, o := range occupants {
		if o.ID != account.Session.Visitor.ID || o.ConnectionID == "" {
			t.Fatalf("connection/person binding = %v", o)
		}
	}
	firstClient.room.Disconnect()
	waitForParticipants(t, liveKitClient(), f.room, two.GrantID, three.GrantID)
	// A local SDK disconnect leaves the original exact grant authorized.
	reconnected := connect(t, one)
	waitForParticipants(t, liveKitClient(), f.room, one.GrantID, two.GrantID, three.GrantID)
	f.gate.Lock()
	effects, err := f.ident.Logout(t.Context(), account.Token)
	if err == nil {
		err = f.gate.Apply(t.Context(), effects)
	}
	f.gate.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, client := range []voiceClient{reconnected, secondClient} {
		select {
		case <-client.disconnected:
		case <-time.After(2 * time.Second):
			t.Fatal("logout did not close every same-session media connection")
		}
	}
	refusedAtGuard(t, f, one.Token)
	refusedAtGuard(t, f, two.Token)
	waitForParticipants(t, liveKitClient(), f.room, three.GrantID)
	select {
	case <-thirdClient.disconnected:
		t.Fatal("logout closed other session")
	default:
	}
	f.gate.Lock()
	recovered := recoverAccount(t, f.ident, key)
	err = f.gate.Apply(t.Context(), recovered.Effects)
	f.gate.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-thirdClient.disconnected:
	case <-time.After(2 * time.Second):
		t.Fatal("recovery did not close remaining old media")
	}
	refusedAtGuard(t, f, three.Token)
	fresh, other := f.join(t, recovered.Session), f.join(t, recovered.Session)
	finalClient, otherClient := connect(t, fresh), connect(t, other)
	f.gate.Lock()
	effects, err = f.ident.DisableAccount(t.Context(), account.Session.Visitor.ID)
	if err == nil {
		err = f.gate.Apply(t.Context(), effects)
	}
	f.gate.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, client := range []voiceClient{finalClient, otherClient} {
		select {
		case <-client.disconnected:
		case <-time.After(2 * time.Second):
			t.Fatal("disable did not close all media")
		}
	}
	refusedAtGuard(t, f, fresh.Token)
	refusedAtGuard(t, f, other.Token)
	waitForParticipants(t, liveKitClient(), f.room)
}

func TestGuardedLiveKitAcceptsRefreshedTokenOnlyForCurrentImmutableGrant(t *testing.T) {
	f := newGuardedVoice(t)
	account, key := f.enroll(t)
	creds := f.join(t, account.Session)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	ws, response, err := websocket.Dial(ctx, f.public.URL+"/rtc?protocol=15&auto_subscribe=0&access_token="+url.QueryEscape(creds.Token), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ws.CloseNow() }()
	_, data, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var joined livekit.SignalResponse
	if err := proto.Unmarshal(data, &joined); err != nil {
		t.Fatal(err)
	}
	transport := joined.GetJoin().GetParticipant().GetIdentity()
	// Editable attributes and metadata cannot change the signed transport binding.
	request := &livekit.SignalRequest{Message: &livekit.SignalRequest_UpdateMetadata{UpdateMetadata: &livekit.UpdateParticipantMetadata{Metadata: `{"session":"forged"}`, Attributes: map[string]string{"deafened": "true", "grant": "forged"}, RequestId: 1}}}
	data, err = proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatal(err)
	}
	api := lksdk.NewRoomServiceClient(fmt.Sprintf("http://127.0.0.1:%d", liveKitPort), devKey, devSecret)
	if _, err := api.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{Room: f.room, Identity: transport, Permission: &livekit.ParticipantPermission{CanSubscribe: true, CanPublish: true, CanUpdateMetadata: true}}); err != nil {
		t.Fatal(err)
	}
	var refreshed string
	for refreshed == "" {
		_, data, err = ws.Read(ctx)
		if err != nil {
			t.Fatalf("LiveKit did not issue a refreshed token: %v", err)
		}
		var signal livekit.SignalResponse
		if err := proto.Unmarshal(data, &signal); err != nil {
			t.Fatal(err)
		}
		refreshed = signal.GetRefreshToken()
	}
	if refreshed == creds.Token {
		t.Fatal("LiveKit refresh returned original JWT")
	}
	_ = ws.CloseNow()
	// An actually refreshed LiveKit JWT (not a re-signed fixture) reconnects.
	connect(t, voice.Credentials{URL: creds.URL, Token: refreshed})
	second := f.login(t, key)
	connect(t, f.join(t, second.Session))
	req := httptest.NewRequestWithContext(t.Context(), "GET", "/rtc/validate?access_token="+url.QueryEscape(refreshed), nil)
	res := httptest.NewRecorder()
	f.voice.Signalling(fmt.Sprintf("http://127.0.0.1:%d", liveKitPort)).ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("independent Join invalidated refreshed token: %d", res.Code)
	}
	f.gate.Lock()
	effects, err := f.ident.Logout(t.Context(), account.Token)
	if err == nil {
		err = f.gate.Apply(t.Context(), effects)
	}
	f.gate.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	refusedAtGuard(t, f, refreshed)
}

func TestGuardedLiveKitMaintenanceEndsExpiredIdleMediaWithoutHTTPRequest(t *testing.T) {
	for _, kind := range []identity.Kind{identity.Account} {
		t.Run(string(kind), func(t *testing.T) {
			ttl := identity.AccountSessionTTL
			var clockMu sync.Mutex
			offset := time.Duration(0)
			f := newGuardedVoice(t, identity.WithClock(func() time.Time { clockMu.Lock(); defer clockMu.Unlock(); return time.Now().Add(offset) }))
			account, _ := f.enroll(t)
			session := account.Session
			creds := f.join(t, session)
			client := connect(t, creds)
			clockMu.Lock()
			offset = ttl
			clockMu.Unlock()
			if _, err := f.ident.ValidateSession(t.Context(), session); !errors.Is(err, identity.ErrNoVisitor) {
				t.Fatalf("expired request was accepted: %v", err)
			}
			refusedAtGuard(t, f, creds.Token)
			select {
			case <-client.disconnected:
				t.Fatal("established media closed before maintenance")
			case <-time.After(30 * time.Millisecond):
			}
			if err := f.gate.Maintain(t.Context(), nil, f.voice); err != nil {
				t.Fatal(err)
			}
			select {
			case <-client.disconnected:
			case <-time.After(2 * time.Second):
				t.Fatal("maintenance left expired idle media connected")
			}
			waitForParticipants(t, liveKitClient(), f.room)
			refusedAtGuard(t, f, creds.Token)
		})
	}
}
