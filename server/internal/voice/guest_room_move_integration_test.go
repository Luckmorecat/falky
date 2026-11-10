//go:build integration

package voice_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/kisshot/falky/server/internal/voice"
	"github.com/kisshot/falky/server/internal/voice/voicetest"
)

func TestGuardedLiveKitGuestJoinsKeepOrdinaryAndRestoredConnections(t *testing.T) {
	for _, restored := range []bool{false, true} {
		t.Run(fmt.Sprintf("restored=%t", restored), func(t *testing.T) {
			f := newGuardedVoice(t)
			second, err := f.rooms.Create(t.Context(), "Second")
			if err != nil {
				t.Fatal(err)
			}
			third, err := f.rooms.Create(t.Context(), "Third")
			if err != nil {
				t.Fatal(err)
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
			join := func(room string) voice.Credentials {
				f.gate.Lock()
				defer f.gate.Unlock()
				creds, err := f.voice.JoinSession(t.Context(), session, room)
				if err != nil {
					t.Fatal(err)
				}
				creds.URL = "ws" + strings.TrimPrefix(f.public.URL, "http")
				return creds
			}
			old := join(f.room)
			if restored {
				f = restartGuardedVoice(t, f)
			}
			old.URL = "ws" + strings.TrimPrefix(f.public.URL, "http")
			first := connect(t, old)
			track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = track.Close() }()
			if _, err := first.room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "Microphone", Source: livekit.TrackSource_MICROPHONE}); err != nil {
				t.Fatal(err)
			}
			if err := track.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}, nil); err != nil {
				t.Fatal(err)
			}
			listed, err := liveKitClient().Participants(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			var oldParticipant voice.Participant
			for _, participant := range listed {
				if participant.Room == f.room && participant.Identity == old.GrantID {
					oldParticipant = participant
				}
			}
			if oldParticipant.SID == "" {
				t.Fatal("old guest media not listed")
			}
			sameRoom := join(f.room)
			connect(t, sameRoom)
			waitForParticipants(t, liveKitClient(), f.room, old.GrantID, sameRoom.GrantID)
			current := join(second.ID)
			inSecond := connect(t, current)
			waitForParticipants(t, liveKitClient(), second.ID, current.GrantID)
			if err := f.voice.ReceiveWebhook(signed(t, voicetest.Joined(oldParticipant), devKey, devSecret)); err != nil {
				t.Fatal(err)
			}
			newest := join(third.ID)
			connect(t, newest)
			waitForParticipants(t, liveKitClient(), f.room, old.GrantID, sameRoom.GrantID)
			waitForParticipants(t, liveKitClient(), second.ID, current.GrantID)
			waitForParticipants(t, liveKitClient(), third.ID, newest.GrantID)
			for _, client := range []voiceClient{first, inSecond} {
				select {
				case <-client.disconnected:
					t.Fatal("independent Join closed older media")
				default:
				}
			}
			inSecond.room.Disconnect()
			waitForParticipants(t, liveKitClient(), second.ID)
			waitForParticipants(t, liveKitClient(), f.room, old.GrantID, sameRoom.GrantID)
			waitForParticipants(t, liveKitClient(), third.ID, newest.GrantID)
			connect(t, current)
			waitForParticipants(t, liveKitClient(), second.ID, current.GrantID)
		})
	}
}
