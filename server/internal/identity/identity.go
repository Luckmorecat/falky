// Package identity owns the access link and the visitors it admits.
package identity

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"time"

	"github.com/kisshot/falky/server/internal/platform"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations returns the schema migrations of the tables identity owns.
func Migrations() fs.FS {
	sub, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		panic(err) // the directory is embedded above
	}
	return sub
}

// Service manages the access link and the visitors it admits. Which visitor
// holds which name lives in the Service's memory, so the server uses one
// Service for every request.
type Service struct {
	db           *platform.DB
	origin       string
	now          func() time.Time
	reservations *reservations
}

// Option changes how New sets up the Service.
type Option func(*Service)

// WithClock makes the Service read the time from now instead of the system
// clock.
func WithClock(now func() time.Time) Option {
	return func(s *Service) { s.now = now }
}

// New returns the service over db. publicOrigin is where visitors reach the
// server, for example https://falky.example; links are built on it.
func New(db *platform.DB, publicOrigin string, opts ...Option) *Service {
	s := &Service{db: db, origin: publicOrigin, now: time.Now, reservations: newReservations()}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// EnsureLink creates the access link, with a new random secret and the first
// generation, when there is none yet. It reports whether it created one; an
// existing link is kept as it is.
func (s *Service) EnsureLink(ctx context.Context) (created bool, err error) {
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		// rand.Text is 128 random bits in base32, which is URL-safe.
		res, err := tx.ExecContext(ctx, `INSERT INTO access (id, link_secret, generation, rotated_at)
			VALUES (1, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			ON CONFLICT (id) DO NOTHING`, rand.Text())
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		created = n == 1
		return err
	})
	if err != nil {
		return false, fmt.Errorf("ensure access link: %w", err)
	}
	return created, nil
}

// ErrNoLink reports that the access link has not been created yet.
var ErrNoLink = errors.New("no access link")

// Link returns the current access link: the public origin with the secret in
// the URL fragment, which browsers never send to a server.
func (s *Service) Link(ctx context.Context) (string, error) {
	var secret string
	err := s.db.Read().QueryRowContext(ctx, "SELECT link_secret FROM access WHERE id = 1").Scan(&secret)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNoLink
	}
	if err != nil {
		return "", fmt.Errorf("read access link: %w", err)
	}
	return s.linkTo(secret), nil
}

// linkTo is the access link that carries secret.
func (s *Service) linkTo(secret string) string {
	return s.origin + "/#k=" + secret
}

// Rotate replaces the access link with one on a new random secret and
// returns it. Rotating starts the next generation, which ends the access of
// every visitor admitted so far: their cookies are refused from then on. It
// also frees every name visitors held, so those of the new link can take any.
// It fails with ErrNoLink before the link is created.
func (s *Service) Rotate(ctx context.Context) (string, error) {
	secret := rand.Text()
	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE access
			SET link_secret = ?, generation = generation + 1, rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE id = 1`, secret)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err == nil && n == 0 {
			return ErrNoLink
		}
		return err
	})
	if errors.Is(err, ErrNoLink) {
		return "", err
	}
	if err != nil {
		return "", fmt.Errorf("rotate access link: %w", err)
	}
	s.reservations.dropAll()
	return s.linkTo(secret), nil
}
