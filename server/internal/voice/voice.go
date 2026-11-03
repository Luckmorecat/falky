// Package voice issues the LiveKit tokens visitors join a room's voice with,
// and keeps each visitor a participant in at most one room. LiveKit owns the
// media and who is a participant; the server reaches it through a LiveKit,
// either the client of a real server or a fake in tests.
package voice

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"

	"github.com/kisshot/falky/server/internal/identity"
)

// TokenLifetime is how long a voice token admits its holder. It only bounds
// how long a client may wait before connecting: once connected, LiveKit keeps
// handing the client fresh tokens.
const TokenLifetime = 10 * time.Minute

// LiveKit is the LiveKit server, as voice uses it. Rooms are named by room ID
// and participants by visitor ID.
type LiveKit interface {
	// Participants lists the participants of every room.
	Participants(ctx context.Context) ([]Participant, error)
	// RemoveParticipant disconnects the participant identity from room. It
	// succeeds when identity is not a participant there.
	RemoveParticipant(ctx context.Context, room, identity string) error
}

// Participant is a visitor in a room's voice, as LiveKit lists them.
type Participant struct {
	// Room is the room's ID.
	Room string
	// Identity is the visitor's ID.
	Identity string
}

// Credentials are what a client connects to a room's voice with.
type Credentials struct {
	// URL is where the client reaches LiveKit.
	URL string
	// Token admits the visitor to the room's voice for TokenLifetime.
	Token string
}

// ErrRoomFull reports a room whose voice already has as many participants as
// it admits.
var ErrRoomFull = errors.New("the room's voice is full")

// ErrUnavailable reports that LiveKit could not be reached; the wrapping error
// says how.
var ErrUnavailable = errors.New("voice is unavailable")

// Config is how the Service issues tokens.
type Config struct {
	// URL is where clients reach LiveKit.
	URL string
	// APIKey and APISecret sign the tokens. The secret never leaves the
	// server; the key names the signer in each token, so clients see it.
	APIKey, APISecret string
	// RoomCap is the most participants a room's voice admits.
	RoomCap int
}

// Service lets visitors join rooms' voice.
type Service struct {
	livekit LiveKit
	cfg     Config

	mu sync.Mutex
	// issued holds, by visitor ID, the room ID of the last token issued to
	// the visitor since the server started.
	issued map[string]string
}

// New returns the service over lk, issuing tokens as cfg says.
func New(lk LiveKit, cfg Config) *Service {
	return &Service{livekit: lk, cfg: cfg, issued: make(map[string]string)}
}

// Join returns the credentials visitor joins the voice of the room roomID
// with. It first removes the visitor from every other room's voice, so they
// are a participant in one room at most. It fails with ErrRoomFull when the
// room already has RoomCap participants other than the visitor (a second
// connection of the visitor replaces the first, so it takes no place), or
// with an ErrUnavailable. The caller checks that the room exists and that
// the visitor may join it.
func (s *Service) Join(ctx context.Context, visitor identity.Visitor, roomID string) (Credentials, error) {
	participants, err := s.livekit.Participants(ctx)
	if err != nil {
		return Credentials{}, fmt.Errorf("%w: list participants: %w", ErrUnavailable, err)
	}
	others := 0
	var elsewhere []string
	for _, p := range participants {
		switch {
		case p.Identity != visitor.ID:
			if p.Room == roomID {
				others++
			}
		case p.Room != roomID:
			elsewhere = append(elsewhere, p.Room)
		}
	}
	if others >= s.cfg.RoomCap {
		return Credentials{}, ErrRoomFull
	}
	for _, room := range elsewhere {
		if err := s.livekit.RemoveParticipant(ctx, room, visitor.ID); err != nil {
			return Credentials{}, fmt.Errorf("%w: remove from room %s: %w", ErrUnavailable, room, err)
		}
	}
	token, err := s.token(visitor, roomID)
	if err != nil {
		return Credentials{}, err
	}
	s.mu.Lock()
	s.issued[visitor.ID] = roomID
	s.mu.Unlock()
	return Credentials{URL: s.cfg.URL, Token: token}, nil
}

// token mints the token visitor joins the voice of the room roomID with: the
// visitor's ID as identity and name as display name, for that room only. It
// may publish the microphone, a screen share and its audio, subscribe, and
// set its own attributes, which is how a client shows it is deafened (the
// attribute "deafened"). It may not send data messages: chat goes over HTTP.
func (s *Service) token(visitor identity.Visitor, roomID string) (string, error) {
	grant := &auth.VideoGrant{RoomJoin: true, Room: roomID}
	grant.SetCanPublish(true)
	grant.SetCanPublishSources([]livekit.TrackSource{
		livekit.TrackSource_MICROPHONE,
		livekit.TrackSource_SCREEN_SHARE,
		livekit.TrackSource_SCREEN_SHARE_AUDIO,
	})
	// Unset, data messages would follow CanPublish.
	grant.SetCanPublishData(false)
	grant.SetCanSubscribe(true)
	grant.SetCanUpdateOwnMetadata(true)
	token, err := auth.NewAccessToken(s.cfg.APIKey, s.cfg.APISecret).
		SetIdentity(visitor.ID).
		SetName(visitor.Name).
		SetVideoGrant(grant).
		SetValidFor(TokenLifetime).
		// A room LiveKit creates for this token admits RoomCap participants,
		// which also holds when tokens are issued faster than their holders
		// connect.
		SetRoomConfig(&livekit.RoomConfiguration{MaxParticipants: uint32(s.cfg.RoomCap)}).
		ToJWT()
	if err != nil {
		return "", fmt.Errorf("mint voice token: %w", err)
	}
	return token, nil
}

// IssuedRoom returns the ID of the room whose voice the visitor visitorID was
// last issued a token for, and false when they were issued none since the
// server started.
func (s *Service) IssuedRoom(visitorID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room, ok := s.issued[visitorID]
	return room, ok
}

// Check fails while LiveKit cannot be reached.
func (s *Service) Check(ctx context.Context) error {
	_, err := s.livekit.Participants(ctx)
	return err
}
