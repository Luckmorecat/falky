//go:build integration

package voice_test

import (
	"context"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func TestGuardedLiveKitCommittedRevocationSurvivesCallerCancellation(t *testing.T) {
	for _, operation := range []string{"disable", "recovery"} {
		t.Run(operation, func(t *testing.T) {
			f := newGuardedVoice(t)
			account, _ := f.enroll(t)
			creds := f.join(t, account.Session)
			client := connect(t, creds)
			track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = track.Close() }()
			if _, err := client.room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "Microphone", Source: livekit.TrackSource_MICROPHONE}); err != nil {
				t.Fatal(err)
			}
			if err := track.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}, nil); err != nil {
				t.Fatal(err)
			}
			var recovery identity.Ceremony
			var replacement *passkeytest.Authenticator
			if operation == "recovery" {
				recovery, err = f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, account.RecoveryCodes[0], "recovery")
				if err != nil {
					t.Fatal(err)
				}
				replacement = passkeytest.New(t)
			}
			var effects identity.Effects
			var recovered identity.Enrollment
			f.gate.Lock()
			if operation == "disable" {
				effects, err = f.ident.DisableAccount(t.Context(), account.Session.Visitor.ID)
			} else {
				recovered, err = f.ident.FinishRecovery(t.Context(), recovery.ID, "recovery", replacement.Registration(t, recovery.Creation, "https://falky.example"), "Replacement")
				effects = recovered.Effects
			}
			if err != nil {
				f.gate.Unlock()
				t.Fatal(err)
			}
			cancelled, cancel := context.WithCancel(t.Context())
			cancel()
			err = f.gate.Apply(cancelled, effects)
			f.gate.Unlock()
			if err != nil {
				t.Fatalf("committed %s enforcement followed caller cancellation: %v", operation, err)
			}
			listed, err := liveKitClient().Participants(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			for _, participant := range listed {
				if participant.Room == f.room {
					t.Fatalf("%s returned before removing revoked media: %v", operation, participant)
				}
			}
			select {
			case <-client.disconnected:
			case <-time.After(2 * time.Second):
				t.Fatal("revoked media client remained connected")
			}
			refusedAtGuard(t, f, creds.Token)
			if operation == "recovery" {
				if _, err := f.ident.ValidateSession(t.Context(), recovered.Session); err != nil {
					t.Fatalf("new recovery session was revoked: %v", err)
				}
				connect(t, f.join(t, recovered.Session))
			}
		})
	}
}
