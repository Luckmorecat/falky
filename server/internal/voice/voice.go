// Package voice authorizes independent room connections and keeps a view of
// each room's occupancy. LiveKit owns the media and who is a participant; the
// server reaches it through a LiveKit, either the client of a real server or
// a fake in tests, and learns of joins and leaves from LiveKit's webhooks and
// its participant listing.
package voice

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/oklog/ulid/v2"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
)

// TokenLifetime is how long a voice token admits its holder. It only bounds
// how long a client may wait before connecting: once connected, LiveKit keeps
// handing the client fresh tokens.
const TokenLifetime = 10 * time.Minute

// LiveKit is the LiveKit server, as voice uses it. Rooms are named by room ID
// and participants by immutable grant transport identity.
type LiveKit interface {
	// Participants lists the participants of every room.
	Participants(ctx context.Context) ([]Participant, error)
	// RemoveParticipant disconnects the participant identity from room. It
	// succeeds when identity is not a participant there.
	RemoveParticipant(ctx context.Context, room, identity string) error
	// RemoveAll disconnects every participant of every room.
	RemoveAll(ctx context.Context) error
}

// Participant is a visitor in a room's voice, as LiveKit lists them.
type Participant struct {
	// Room is the room's ID.
	Room string
	// Identity is the immutable transport identity, prefixed by the app identity.
	Identity string
	// SID is LiveKit's ID of this one connection to the room's voice: a
	// second tab of the visitor has another.
	SID string
}

// Visitors is who has access, as identity.Service tells it.
type Visitors interface {
	// Visitor returns the visitor visitorID while they have current access,
	// and fails with identity.ErrNoVisitor otherwise.
	Visitor(ctx context.Context, visitorID string) (identity.Visitor, error)
}

// Rooms is what a visitor may do in a room, as rooms.Service tells it.
type Rooms interface {
	// Authorize fails when visitor may not do action in the room roomID:
	// with rooms.ErrNotFound for an unknown room, identity.ErrNameTaken for a
	// visitor whose name another connected visitor holds, or another error
	// when it could not tell.
	Authorize(ctx context.Context, visitor identity.Visitor, roomID string, action rooms.Action) error
}

// Credentials are what a client connects to a room's voice with.
type Credentials struct {
	// GrantID is the immutable transport to target with an explicit Leave.
	GrantID string
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

// Service lets visitors join rooms' voice and keeps the view of who is in
// each room's voice.
type Service struct {
	db       *platform.DB
	livekit  LiveKit
	visitors Visitors
	rooms    Rooms
	cfg      Config
	keys     auth.KeyProvider
	publish  func(roomID string, occupancy []Occupant)
	logger   *slog.Logger

	// publishing holds each change to the view, from reading what changed
	// until it has published, so changes apply and publish one at a time.
	publishing operationGate

	// storeMu prevents hydration from restoring a cached pre-revocation snapshot.
	storeMu    operationGate
	mu         sync.Mutex
	joining    sync.Mutex
	grants     map[string]*voiceGrant
	admission  sync.Locker
	validate   func(context.Context, identity.Session) (identity.Session, error)
	guardedURL string
	// view holds, by room ID, the participants of each room's voice by SID.
	view map[string]map[string]Occupant
}

// Option changes how New sets up the Service.
type Option func(*Service)

// WithPublisher makes the Service hand each room's occupancy to publish once
// it has changed, in the order the changes apply. publish must not block.
func WithPublisher(publish func(roomID string, occupancy []Occupant)) Option {
	return func(s *Service) { s.publish = publish }
}

// WithLogger makes Run log the refreshes that fail, and the Service log the
// participants it removes, to logger.
func WithLogger(logger *slog.Logger) Option {
	return func(s *Service) { s.logger = logger }
}

// New returns the service over lk, issuing tokens as cfg says. A participant
// stays in a room's voice only while visitors says they have current access
// and rs lets them join it.
func New(lk LiveKit, visitors Visitors, rs Rooms, cfg Config, opts ...Option) *Service {
	s := &Service{
		livekit:  lk,
		visitors: visitors,
		rooms:    rs,
		cfg:      cfg,
		keys:     auth.NewSimpleKeyProvider(cfg.APIKey, cfg.APISecret),
		publish:  func(string, []Occupant) {},
		logger:   slog.New(slog.DiscardHandler),
		view:     make(map[string]map[string]Occupant),
		grants:   make(map[string]*voiceGrant),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Join authorizes a fresh independent connection. Services using WithDB require
// JoinSession so every durable grant has an exact session binding.
func (s *Service) Join(ctx context.Context, visitor identity.Visitor, roomID string) (Credentials, error) {
	return s.join(ctx, identity.Session{Visitor: visitor, Kind: identity.Guest}, roomID, false)
}

// JoinSession authorizes one new connection without changing any other grant.
// Its caller holds the lifecycle gate through session validation and issuance.
func (s *Service) JoinSession(ctx context.Context, session identity.Session, roomID string) (Credentials, error) {
	return s.join(ctx, session, roomID, true)
}

func (s *Service) join(ctx context.Context, session identity.Session, roomID string, bound bool) (Credentials, error) {
	if s.db != nil && (!bound || session.ID == "") {
		return Credentials{}, identity.ErrNoVisitor
	}
	s.joining.Lock()
	defer s.joining.Unlock()
	visitor := session.Visitor
	transport := visitor.ID + "." + ulid.Make().String()
	participants, err := s.livekit.Participants(ctx)
	if err != nil {
		return Credentials{}, fmt.Errorf("%w: list participants: %w", ErrUnavailable, err)
	}
	count := 0
	for _, p := range participants {
		if p.Room == roomID {
			count++
		}
	}
	if count >= s.cfg.RoomCap {
		return Credentials{}, ErrRoomFull
	}
	token, err := s.token(identity.Visitor{ID: transport, Name: visitor.Name, Colour: visitor.Colour}, roomID)
	if err != nil {
		return Credentials{}, err
	}
	g := &voiceGrant{session: session, transport: transport, room: roomID, sockets: make(map[*signalConnection]struct{})}
	if err := s.saveGrant(ctx, g); err != nil {
		return Credentials{}, err
	}
	connectionURL := s.cfg.URL
	if s.guardedURL != "" {
		connectionURL = s.guardedURL
	}
	return Credentials{URL: connectionURL, Token: token, GrantID: transport}, nil
}

// token mints the token visitor joins the voice of the room roomID with: the
// visitor's ID as identity and name as display name, for that room only. It
// may publish the microphone, a camera, a screen share and its audio, subscribe, and
// set its own attributes, which is how a client shows it is deafened (the
// attribute "deafened"). It may not send data messages: chat goes over HTTP.
func (s *Service) token(visitor identity.Visitor, roomID string) (string, error) {
	grant := &auth.VideoGrant{RoomJoin: true, Room: roomID}
	grant.SetCanPublish(true)
	grant.SetCanPublishSources([]livekit.TrackSource{
		livekit.TrackSource_MICROPHONE,
		livekit.TrackSource_CAMERA,
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

// Check fails while LiveKit cannot be reached.
func (s *Service) Check(ctx context.Context) error {
	_, err := s.livekit.Participants(ctx)
	return err
}
