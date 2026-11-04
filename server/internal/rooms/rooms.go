// Package rooms owns the rooms visitors talk in, and the one check of what a
// visitor may do in a room.
package rooms

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"sync"

	"github.com/oklog/ulid/v2"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations returns the schema migrations of the tables rooms owns.
func Migrations() fs.FS {
	sub, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		panic(err) // the directory is embedded above
	}
	return sub
}

// Room is a named place where visitors talk by voice and chat.
type Room struct {
	// ID is a ULID; it never changes.
	ID   string
	Name string
}

// ErrNotFound reports a room ID that names no room.
var ErrNotFound = errors.New("no such room")

// ErrNameTaken reports a name another room has.
var ErrNameTaken = errors.New("another room has this name")

// ErrInvalidName reports a room name that breaks the name rules, which are
// those of visitor names; the wrapping error says which rule.
var ErrInvalidName = identity.ErrInvalidName

// Action is something a visitor does in a room.
type Action int

const (
	// ReadMessages is reading a room's chat.
	ReadMessages Action = iota + 1
	// PostMessage is posting a message in a room's chat.
	PostMessage
	// JoinVoice is joining a room's voice.
	JoinVoice
)

// Service manages the rooms.
type Service struct {
	db        *platform.DB
	publish   func(Room)
	nameTaken func(identity.Visitor) bool
	// publishing holds each change from its write until it has published, so
	// changes are published in the order they are committed.
	publishing sync.Mutex
}

// Option changes how New sets up the Service.
type Option func(*Service)

// WithPublisher makes Create and Rename hand the room they changed to publish
// once the change is committed, in the order they are committed. publish
// must not block.
func WithPublisher(publish func(Room)) Option {
	return func(s *Service) { s.publish = publish }
}

// WithNameCheck makes Authorize refuse joining voice, with
// identity.ErrNameTaken, to a visitor for whom nameTaken reports that another
// connected visitor holds their name: voice stays closed to them until they
// rename.
func WithNameCheck(nameTaken func(identity.Visitor) bool) Option {
	return func(s *Service) { s.nameTaken = nameTaken }
}

// New returns the service over db.
func New(db *platform.DB, opts ...Option) *Service {
	s := &Service{db: db, publish: func(Room) {}, nameTaken: func(identity.Visitor) bool { return false }}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// List returns every room, in the order they were created.
func (s *Service) List(ctx context.Context) ([]Room, error) {
	rows, err := s.db.Read().QueryContext(ctx, "SELECT id, name FROM rooms ORDER BY id")
	if err != nil {
		return nil, fmt.Errorf("list rooms: %w", err)
	}
	rooms, err := scanRooms(rows)
	if err != nil {
		return nil, fmt.Errorf("list rooms: %w", err)
	}
	return rooms, nil
}

// Create creates a room named name, trimmed. It fails with an ErrInvalidName,
// or ErrNameTaken when another room has the name, compared as visitor names
// are.
func (s *Service) Create(ctx context.Context, name string) (Room, error) {
	name, err := identity.CleanName(name)
	if err != nil {
		return Room{}, err
	}
	r := Room{ID: ulid.Make().String(), Name: name}
	s.publishing.Lock()
	defer s.publishing.Unlock()
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		if err := checkNameFree(ctx, tx, name, ""); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO rooms (id, name, created_at)
			VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, r.ID, r.Name)
		return err
	})
	if errors.Is(err, ErrNameTaken) {
		return Room{}, err
	}
	if err != nil {
		return Room{}, fmt.Errorf("create room: %w", err)
	}
	s.publish(r)
	return r, nil
}

// Rename changes the name of the room id to name, trimmed. It fails with an
// ErrInvalidName, ErrNotFound for an unknown room, or ErrNameTaken when
// another room has the name. A room may change the case of its own name.
func (s *Service) Rename(ctx context.Context, id, name string) (Room, error) {
	name, err := identity.CleanName(name)
	if err != nil {
		return Room{}, err
	}
	s.publishing.Lock()
	defer s.publishing.Unlock()
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		if err := checkExists(ctx, tx, id); err != nil {
			return err
		}
		if err := checkNameFree(ctx, tx, name, id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE rooms SET name = ? WHERE id = ?", name, id)
		return err
	})
	if errors.Is(err, ErrNameTaken) || errors.Is(err, ErrNotFound) {
		return Room{}, err
	}
	if err != nil {
		return Room{}, fmt.Errorf("rename room: %w", err)
	}
	r := Room{ID: id, Name: name}
	s.publish(r)
	return r, nil
}

// checkNameFree fails with ErrNameTaken when a room other than exceptID has a
// name with the same key as name. The rooms are few, so it compares them all;
// the write transaction keeps another writer from adding one meanwhile.
func checkNameFree(ctx context.Context, tx *sql.Tx, name, exceptID string) error {
	rows, err := tx.QueryContext(ctx, "SELECT id, name FROM rooms WHERE id <> ?", exceptID)
	if err != nil {
		return err
	}
	rooms, err := scanRooms(rows)
	if err != nil {
		return err
	}
	key := identity.NameKey(name)
	for _, r := range rooms {
		if identity.NameKey(r.Name) == key {
			return ErrNameTaken
		}
	}
	return nil
}

func scanRooms(rows *sql.Rows) (rooms []Room, err error) {
	defer func() { err = errors.Join(err, rows.Close()) }()
	for rows.Next() {
		var r Room
		if err := rows.Scan(&r.ID, &r.Name); err != nil {
			return nil, err
		}
		rooms = append(rooms, r)
	}
	return rooms, rows.Err()
}

// Authorize is the one check of whether visitor may do action in the room
// roomID; every handler of a room-scoped request calls it first. It fails
// with ErrNotFound for an unknown room, and with identity.ErrNameTaken when
// the visitor would join voice under a name another connected visitor holds.
// Otherwise every visitor may do everything in every room.
func (s *Service) Authorize(ctx context.Context, visitor identity.Visitor, roomID string, action Action) error {
	err := checkExists(ctx, s.db.Read(), roomID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return fmt.Errorf("authorize room access: %w", err)
	}
	if err == nil && action == JoinVoice && s.nameTaken(visitor) {
		return identity.ErrNameTaken
	}
	return err
}

// querier is what checkExists reads through: the read pool or a write
// transaction.
type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// checkExists fails with ErrNotFound when no room has the ID id.
func checkExists(ctx context.Context, q querier, id string) error {
	var exists bool
	if err := q.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM rooms WHERE id = ?)", id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}
