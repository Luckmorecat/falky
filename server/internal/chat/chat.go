// Package chat owns the messages visitors post in each room's chat.
package chat

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/oklog/ulid/v2"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations returns the schema migrations of the tables chat owns. They
// follow those of rooms, whose table they reference.
func Migrations() fs.FS {
	sub, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		panic(err) // the directory is embedded above
	}
	return sub
}

// Message is a piece of text a visitor posted in a room's chat.
type Message struct {
	// ID is a ULID. IDs sort in the order their messages were committed.
	ID     string
	RoomID string
	// AuthorID and AuthorName are the author's visitor ID and their name
	// when they posted.
	AuthorID   string
	AuthorName string
	// Body is the text as posted.
	Body      string
	CreatedAt time.Time
}

// maxBodyLength is the longest message body, in characters.
const maxBodyLength = 4000

// History returns at most MaxLimit messages at a time; DefaultLimit is the
// page size for callers that name none.
const (
	DefaultLimit = 50
	MaxLimit     = 100
)

// requestKeyPattern is what a request key looks like: short enough to store
// with every message, and wide enough for a UUID or a ULID.
var requestKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// timeLayout is how created_at is stored: UTC to the millisecond.
const timeLayout = "2006-01-02T15:04:05.000Z"

// selectMessages selects the columns scanMessage reads, in its order.
const selectMessages = "SELECT id, room_id, author_id, author_name, body, created_at FROM messages"

var (
	// ErrInvalidBody reports a message body that breaks the message rules;
	// the wrapping error says which.
	ErrInvalidBody = errors.New("invalid message body")
	// ErrInvalidRequestKey reports a request key that is not 1 to 64
	// letters, digits, '-' or '_'.
	ErrInvalidRequestKey = errors.New("invalid request key: want 1 to 64 letters, digits, '-' or '_'")
	// ErrRequestKeyReused reports a request key the author already used for a
	// different body or in another room.
	ErrRequestKeyReused = errors.New("request key already used for another message")
	// ErrInvalidPage reports a history page that cannot be served; the
	// wrapping error says why.
	ErrInvalidPage = errors.New("invalid history page")
	// ErrRateLimited reports an author who posted too many messages lately.
	ErrRateLimited = errors.New("too many messages")
)

// Service posts and reads messages.
type Service struct {
	db        *platform.DB
	now       func() time.Time
	postLimit *platform.Limiter
	publish   func(Message)
	// publishing holds each Post from its write until it has published, so
	// messages are published in the order they are committed.
	publishing sync.Mutex
}

// Option changes how New sets up the Service.
type Option func(*Service)

// WithClock makes the Service read the time from now instead of the system
// clock.
func WithClock(now func() time.Time) Option {
	return func(s *Service) { s.now = now }
}

// WithPostLimit limits new messages per author with limiter, keyed by visitor
// ID. Without it, posting is not limited.
func WithPostLimit(limiter *platform.Limiter) Option {
	return func(s *Service) { s.postLimit = limiter }
}

// WithPublisher makes Post hand each message it creates to publish once the
// message is committed, in the order they are committed; a repeated request
// creates nothing and publishes nothing. publish must not block.
func WithPublisher(publish func(Message)) Option {
	return func(s *Service) { s.publish = publish }
}

// New returns the service over db.
func New(db *platform.DB, opts ...Option) *Service {
	s := &Service{db: db, now: time.Now, publish: func(Message) {}}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Post posts body in the room roomID as author, under author's name, and
// reports whether it created a message. The caller checks the room first;
// roomID must name a room.
//
// requestKey makes retrying safe: when author already posted body in the
// room under requestKey, Post returns that message and creates nothing. It
// fails with ErrRequestKeyReused when author used requestKey for a different body or
// room, an ErrInvalidBody, ErrInvalidRequestKey, or ErrRateLimited when a new
// message would exceed the post limit; a retry is never limited.
func (s *Service) Post(ctx context.Context, author identity.Visitor, roomID, requestKey, body string) (Message, bool, error) {
	if !requestKeyPattern.MatchString(requestKey) {
		return Message{}, false, ErrInvalidRequestKey
	}
	if err := checkBody(body); err != nil {
		return Message{}, false, err
	}
	var m Message
	created := false
	s.publishing.Lock()
	defer s.publishing.Unlock()
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		existing, err := scanMessage(tx.QueryRowContext(ctx,
			selectMessages+" WHERE author_id = ? AND request_key = ?", author.ID, requestKey))
		switch {
		case err == nil:
			if existing.RoomID != roomID || existing.Body != body {
				return ErrRequestKeyReused
			}
			m = existing
			return nil
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		if s.postLimit != nil && !s.postLimit.Allow(author.ID) {
			return ErrRateLimited
		}
		// The ID is made here, under the writer, after the newest message
		// committed so far, so IDs sort in commit order.
		var newest string
		if err := tx.QueryRowContext(ctx, "SELECT coalesce(max(id), '') FROM messages").Scan(&newest); err != nil {
			return err
		}
		now := s.now().UTC().Truncate(time.Millisecond)
		id, err := nextID(now, newest)
		if err != nil {
			return err
		}
		m = Message{ID: id, RoomID: roomID, AuthorID: author.ID, AuthorName: author.Name, Body: body, CreatedAt: now}
		if _, err := tx.ExecContext(ctx, `INSERT INTO messages
			(id, room_id, author_id, author_name, body, request_key, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			m.ID, m.RoomID, m.AuthorID, m.AuthorName, m.Body, requestKey, now.Format(timeLayout)); err != nil {
			return err
		}
		created = true
		return nil
	})
	if errors.Is(err, ErrRequestKeyReused) || errors.Is(err, ErrRateLimited) {
		return Message{}, false, err
	}
	if err != nil {
		return Message{}, false, fmt.Errorf("post message: %w", err)
	}
	if created {
		s.publish(m)
	}
	return m, created, nil
}

// checkBody checks the message rules: 1 to 4000 characters, not only white
// space.
func checkBody(body string) error {
	switch {
	case !utf8.ValidString(body):
		return fmt.Errorf("%w: not valid UTF-8", ErrInvalidBody)
	case strings.TrimSpace(body) == "":
		return fmt.Errorf("%w: empty", ErrInvalidBody)
	case utf8.RuneCountInString(body) > maxBodyLength:
		return fmt.Errorf("%w: longer than %d characters", ErrInvalidBody, maxBodyLength)
	}
	return nil
}

// nextID returns a new ULID for a message created at now that sorts after
// newest, the ID of the newest message ("" when there is none). When it would
// not, because the clock went back or another message was made in the same
// millisecond, it is the ULID right after newest.
func nextID(now time.Time, newest string) (string, error) {
	id, err := ulid.New(ulid.Timestamp(now), rand.Reader)
	if err != nil {
		return "", err
	}
	if newest == "" {
		return id.String(), nil
	}
	prev, err := ulid.ParseStrict(newest)
	if err != nil {
		return "", fmt.Errorf("newest message ID %q: %w", newest, err)
	}
	if id.Compare(prev) > 0 {
		return id.String(), nil
	}
	for i := len(prev) - 1; i >= 0; i-- {
		prev[i]++
		if prev[i] != 0 {
			break
		}
	}
	return prev.String(), nil
}

// Page is which messages of a room History returns.
type Page struct {
	// Before, when set, is a message ID: History returns the messages before
	// it, newest first.
	Before string
	// After, when set, is a message ID: History returns the messages after
	// it, oldest first. Before and After cannot both be set; with neither,
	// History returns the newest messages, newest first.
	After string
	// Limit is the most messages to return, 1 to MaxLimit.
	Limit int
}

// History returns the messages of the room roomID that page selects. It fails
// with an ErrInvalidPage when both cursors are set, a cursor is not a message
// ID, or the limit is out of range.
func (s *Service) History(ctx context.Context, roomID string, page Page) ([]Message, error) {
	if page.Before != "" && page.After != "" {
		return nil, fmt.Errorf("%w: before and after together", ErrInvalidPage)
	}
	if page.Limit < 1 || page.Limit > MaxLimit {
		return nil, fmt.Errorf("%w: limit must be 1 to %d", ErrInvalidPage, MaxLimit)
	}
	where, order, args := "", "DESC", []any{roomID}
	if cursor := page.Before + page.After; cursor != "" { // at most one is set
		id, err := ulid.ParseStrict(cursor)
		if err != nil {
			return nil, fmt.Errorf("%w: cursor %q is not a message ID", ErrInvalidPage, cursor)
		}
		// IDs are stored in this form, which is the form they compare in.
		where, args = " AND id < ?", append(args, id.String())
		if page.After != "" {
			where, order = " AND id > ?", "ASC"
		}
	}
	query := selectMessages + " WHERE room_id = ?" + where + " ORDER BY id " + order + " LIMIT ?"
	rows, err := s.db.Read().QueryContext(ctx, query, append(args, page.Limit)...)
	if err != nil {
		return nil, fmt.Errorf("read history: %w", err)
	}
	messages, err := scanMessages(rows)
	if err != nil {
		return nil, fmt.Errorf("read history: %w", err)
	}
	return messages, nil
}

// scanner is what scanMessage reads a row through: a single-row result or
// the current row of a result set.
type scanner interface {
	Scan(dest ...any) error
}

func scanMessage(row scanner) (Message, error) {
	var m Message
	var createdAt string
	if err := row.Scan(&m.ID, &m.RoomID, &m.AuthorID, &m.AuthorName, &m.Body, &createdAt); err != nil {
		return Message{}, err
	}
	t, err := time.Parse(timeLayout, createdAt)
	if err != nil {
		return Message{}, fmt.Errorf("message %s: created_at: %w", m.ID, err)
	}
	m.CreatedAt = t
	return m, nil
}

func scanMessages(rows *sql.Rows) (messages []Message, err error) {
	defer func() { err = errors.Join(err, rows.Close()) }()
	messages = []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, m)
	}
	return messages, rows.Err()
}
