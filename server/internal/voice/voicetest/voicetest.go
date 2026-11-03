// Package voicetest provides an in-memory LiveKit for tests of voice and of
// what uses it.
package voicetest

import (
	"context"
	"slices"
	"sync"

	"github.com/kisshot/falky/server/internal/voice"
)

// LiveKit is an in-memory voice.LiveKit. Tests add participants with
// AddParticipant and read what the server removed with Removed.
type LiveKit struct {
	mu           sync.Mutex
	participants []voice.Participant
	removed      []voice.Participant
	err          error
}

var _ voice.LiveKit = (*LiveKit)(nil)

// New returns a LiveKit with no participants.
func New() *LiveKit {
	return &LiveKit{}
}

// AddParticipant makes identity a participant of room, as if a client had
// joined it with a token for it. Adding the same identity to the same room
// again changes nothing: in LiveKit, a second client replaces the first.
func (lk *LiveKit) AddParticipant(room, identity string) {
	lk.mu.Lock()
	defer lk.mu.Unlock()
	p := voice.Participant{Room: room, Identity: identity}
	if !slices.Contains(lk.participants, p) {
		lk.participants = append(lk.participants, p)
	}
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
	p := voice.Participant{Room: room, Identity: identity}
	if i := slices.Index(lk.participants, p); i >= 0 {
		lk.participants = slices.Delete(lk.participants, i, i+1)
		lk.removed = append(lk.removed, p)
	}
	return nil
}
