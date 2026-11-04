// Package voicetest provides an in-memory LiveKit for tests of voice and of
// what uses it, and the signed webhooks LiveKit would send.
package voicetest

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/kisshot/falky/server/internal/voice"
)

// LiveKit is an in-memory voice.LiveKit. Tests add participants with
// AddParticipant and read what the server removed with Removed.
type LiveKit struct {
	mu           sync.Mutex
	participants []voice.Participant
	removed      []voice.Participant
	sids         int
	err          error
}

var _ voice.LiveKit = (*LiveKit)(nil)

// New returns a LiveKit with no participants.
func New() *LiveKit {
	return &LiveKit{}
}

// AddParticipant makes identity a participant of room, as if a client had
// joined it with a token for it, and returns the participant with a new SID.
// As in LiveKit, a second client of the same identity in the same room
// replaces the first.
func (lk *LiveKit) AddParticipant(room, identity string) voice.Participant {
	lk.mu.Lock()
	defer lk.mu.Unlock()
	lk.sids++
	p := voice.Participant{Room: room, Identity: identity, SID: fmt.Sprintf("PA_%d", lk.sids)}
	lk.participants = slices.DeleteFunc(lk.participants, func(o voice.Participant) bool {
		return o.Room == room && o.Identity == identity
	})
	lk.participants = append(lk.participants, p)
	return p
}

// Leave takes p out of the participants, as if their client had left, without
// recording a removal.
func (lk *LiveKit) Leave(p voice.Participant) {
	lk.mu.Lock()
	defer lk.mu.Unlock()
	lk.participants = slices.DeleteFunc(lk.participants, func(o voice.Participant) bool { return o == p })
}

// Fail makes every call fail with err until it is called with nil.
func (lk *LiveKit) Fail(err error) {
	lk.mu.Lock()
	defer lk.mu.Unlock()
	lk.err = err
}

// Removed returns the participants RemoveParticipant removed, in order.
func (lk *LiveKit) Removed() []voice.Participant {
	lk.mu.Lock()
	defer lk.mu.Unlock()
	return slices.Clone(lk.removed)
}

// Participants lists the participants, in the order they were added.
func (lk *LiveKit) Participants(context.Context) ([]voice.Participant, error) {
	lk.mu.Lock()
	defer lk.mu.Unlock()
	if lk.err != nil {
		return nil, lk.err
	}
	return slices.Clone(lk.participants), nil
}

// RemoveParticipant removes identity from room, recording it when it was a
// participant there.
func (lk *LiveKit) RemoveParticipant(_ context.Context, room, identity string) error {
	lk.mu.Lock()
	defer lk.mu.Unlock()
	if lk.err != nil {
		return lk.err
	}
	i := slices.IndexFunc(lk.participants, func(o voice.Participant) bool { return o.Room == room && o.Identity == identity })
	if i >= 0 {
		lk.removed = append(lk.removed, lk.participants[i])
		lk.participants = slices.Delete(lk.participants, i, i+1)
	}
	return nil
}

// Joined is the event LiveKit sends when p has joined their room's voice.
func Joined(p voice.Participant) *livekit.WebhookEvent {
	return participantEvent(webhook.EventParticipantJoined, p)
}

// Left is the event LiveKit sends when p has left their room's voice.
func Left(p voice.Participant) *livekit.WebhookEvent {
	return participantEvent(webhook.EventParticipantLeft, p)
}

// RoomFinished is the event LiveKit sends when it has closed room's voice.
func RoomFinished(room string) *livekit.WebhookEvent {
	return &livekit.WebhookEvent{Event: webhook.EventRoomFinished, Room: &livekit.Room{Name: room}}
}

// participantEvent is the event LiveKit sends when p has done event.
func participantEvent(event string, p voice.Participant) *livekit.WebhookEvent {
	return &livekit.WebhookEvent{
		Event:       event,
		Room:        &livekit.Room{Name: p.Room},
		Participant: &livekit.ParticipantInfo{Sid: p.SID, Identity: p.Identity, State: livekit.ParticipantInfo_ACTIVE},
		CreatedAt:   time.Now().Unix(),
	}
}

// Sign returns event's body as LiveKit sends it, and the Authorization
// header that signs it with apiKey and apiSecret.
func Sign(event *livekit.WebhookEvent, apiKey, apiSecret string) (body []byte, authorization string, err error) {
	body, err = protojson.Marshal(event)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(body)
	authorization, err = auth.NewAccessToken(apiKey, apiSecret).
		SetValidFor(5 * time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).
		ToJWT()
	return body, authorization, err
}
