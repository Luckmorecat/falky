//go:build integration

package voice_test

import (
	"context"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"google.golang.org/protobuf/proto"

	"github.com/kisshot/falky/server/internal/httpapi"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/voice"
)

func restartGuardedVoice(t *testing.T, f guardedVoice) guardedVoice {
	t.Helper()
	f.voice = voice.New(liveKitClient(), f.ident, f.rooms, voice.Config{APIKey: devKey, APISecret: devSecret, RoomCap: 8}, voice.WithDB(f.db))
	f.gate = &httpapi.Lifecycle{Enforce: httpapi.Enforcer(httpapi.Events{}, f.voice)}
	f.public = httptest.NewServer(f.voice.Signalling(fmt.Sprintf("http://127.0.0.1:%d", liveKitPort)))
	f.voice.ConfigureAdmission(f.gate, f.ident.ValidateSession, f.public.URL)
	t.Cleanup(func() { f.voice.CloseSignalling(); f.public.Close() })
	return f
}

func TestGuardedLiveKitOriginalAndRefreshedJWTResumeAfterBackendRestart(t *testing.T) {
	for _, kind := range []identity.Kind{identity.Guest, identity.Account} {
		t.Run(string(kind), func(t *testing.T) {
			f := newGuardedVoice(t)
			session := guardedSession(t, f, kind)
			f.gate.Lock()
			creds, err := f.voice.JoinSession(t.Context(), session, f.room, false)
			f.gate.Unlock()
			if err != nil {
				t.Fatal(err)
			}
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
			if got := joined.GetJoin().GetParticipant().GetIdentity(); got != creds.GrantID {
				t.Fatalf("guest transport = %s, want exact grant transport", got)
			}
			api := lksdk.NewRoomServiceClient(fmt.Sprintf("http://127.0.0.1:%d", liveKitPort), devKey, devSecret)
			if _, err := api.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{Room: f.room, Identity: creds.GrantID, Permission: &livekit.ParticipantPermission{CanSubscribe: true, CanPublish: true, CanUpdateMetadata: true}}); err != nil {
				t.Fatal(err)
			}
			var refreshed string
			for refreshed == "" {
				_, data, err = ws.Read(ctx)
				if err != nil {
					t.Fatalf("guest JWT refresh not received: %v", err)
				}
				var signal livekit.SignalResponse
				if err := proto.Unmarshal(data, &signal); err != nil {
					t.Fatal(err)
				}
				refreshed = signal.GetRefreshToken()
			}
			if refreshed == creds.Token {
				t.Fatal("LiveKit returned the original JWT instead of refreshing")
			}
			_ = ws.CloseNow()
			for _, jwt := range []string{creds.Token, refreshed} {
				f = restartGuardedVoice(t, f)
				client := connect(t, voice.Credentials{URL: "ws" + strings.TrimPrefix(f.public.URL, "http"), Token: jwt})
				waitForParticipants(t, liveKitClient(), f.room, creds.GrantID)
				if err := f.voice.Refresh(t.Context()); err != nil {
					t.Fatal(err)
				}
				if got := f.voice.Occupancy(f.room); len(got) != 1 || got[0].ID != session.Visitor.ID {
					t.Fatalf("restored guest occupancy = %v", got)
				}
				client.room.Disconnect()
			}
		})
	}
}

func guardedSession(t *testing.T, f guardedVoice, kind identity.Kind) identity.Session {
	t.Helper()
	if kind == identity.Account {
		account, _ := f.enroll(t)
		return account.Session
	}
	link, err := f.ident.Link(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	_, cookie, err := f.ident.Enter(t.Context(), strings.TrimPrefix(link, "https://falky.example/#k="), "Guest")
	if err != nil {
		t.Fatal(err)
	}
	session, err := f.ident.ResolveSession(t.Context(), cookie)
	if err != nil {
		t.Fatal(err)
	}
	return session
}
