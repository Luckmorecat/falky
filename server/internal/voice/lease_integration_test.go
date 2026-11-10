//go:build integration

package voice_test

import (
	"context"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"google.golang.org/protobuf/proto"

	"github.com/kisshot/falky/server/internal/voice"
)

func liveKitRefreshedLeaseToken(t *testing.T, f guardedVoice, creds voice.Credentials) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	ws, res, err := websocket.Dial(ctx, f.public.URL+"/rtc?protocol=15&auto_subscribe=0&access_token="+url.QueryEscape(creds.Token), nil)
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ws.CloseNow() }()
	if _, _, err := ws.Read(ctx); err != nil {
		t.Fatal(err)
	}
	api := lksdk.NewRoomServiceClient(fmt.Sprintf("http://127.0.0.1:%d", liveKitPort), devKey, devSecret)
	if _, err := api.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{Room: f.room, Identity: creds.GrantID, Permission: &livekit.ParticipantPermission{CanSubscribe: true, CanPublish: true, CanUpdateMetadata: true}}); err != nil {
		t.Fatal(err)
	}
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var response livekit.SignalResponse
		if err := proto.Unmarshal(data, &response); err != nil {
			t.Fatal(err)
		}
		if refreshed := response.GetRefreshToken(); refreshed != "" {
			if refreshed == creds.Token {
				t.Fatal("expected actual refreshed JWT")
			}
			return refreshed
		}
	}
}

func TestGuardedLiveKitIdleExpiryRejectsStillValidOriginalAndRefreshedJWTs(t *testing.T) {
	clock := &idleClock{now: time.Now()}
	f := newGuardedVoiceWithOptions(t, []voice.Option{voice.WithClock(clock.read)})
	account, _ := f.enroll(t)
	original := f.join(t, account.Session)
	refreshed := liveKitRefreshedLeaseToken(t, f, original)
	if err := liveKitClient().RemoveParticipant(t.Context(), f.room, original.GrantID); err != nil {
		t.Fatal(err)
	}
	waitForParticipants(t, liveKitClient(), f.room)
	if err := f.voice.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	clock.advance(10*time.Minute - time.Nanosecond)
	// The genuine refreshed JWT reconnects the same exact grant within grace.
	refreshedCredentials := original
	refreshedCredentials.Token = refreshed
	client := connect(t, refreshedCredentials)
	waitForParticipants(t, liveKitClient(), f.room, original.GrantID)
	clock.advance(25 * time.Minute)
	if err := f.voice.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-client.disconnected:
		t.Fatal("active connection expired for its age")
	default:
	}
	// A second departure receives a full new grace despite the grant's total age.
	client.room.Disconnect()
	waitForParticipants(t, liveKitClient(), f.room)
	if err := f.voice.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	clock.advance(10*time.Minute - time.Nanosecond)
	client = connect(t, original)
	waitForParticipants(t, liveKitClient(), f.room, original.GrantID)
	client.room.Disconnect()
	waitForParticipants(t, liveKitClient(), f.room)
	if err := f.voice.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	clock.advance(10 * time.Minute)
	// Idle time is controlled independently: both JWTs remain cryptographically
	// valid at real wall time, so denial cannot pass merely due to token expiry.
	for _, token := range []string{original.Token, refreshed} {
		verifier, err := auth.ParseAPIToken(token)
		if err != nil {
			t.Fatal(err)
		}
		claims, _, err := verifier.Verify(devSecret)
		if err != nil || claims.ExpiresAt == nil || !time.Now().Before(claims.ExpiresAt.Time) {
			t.Fatalf("JWT expired independently: %v", err)
		}
		refusedAtGuard(t, f, token)
	}
	if err := f.voice.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.ValidateSession(t.Context(), account.Session); err != nil {
		t.Fatalf("voice idle logged out account: %v", err)
	}
	next := f.join(t, account.Session)
	if next.GrantID == original.GrantID {
		t.Fatal("new Join resurrected expired grant")
	}
	connect(t, next)
	waitForParticipants(t, liveKitClient(), f.room, next.GrantID)
}
