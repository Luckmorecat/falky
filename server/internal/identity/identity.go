// Package identity owns persistent identities, guest access and passkey accounts.
package identity

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"sync"
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

// Service manages guest access and durable passkey accounts. Guest connected
// name holds live in memory, so the server uses one Service for every request.
type Service struct {
	db           *platform.DB
	origin       string
	now          func() time.Time
	reservations *reservations
	colourMu     sync.Mutex
	connected    map[string]bool
	chooseColour func(int) int
	signInCode   func() (string, error)
}

// Option changes how New sets up the Service.
type Option func(*Service)

// WithClock makes the Service read the time from now instead of the system
// clock.
func WithClock(now func() time.Time) Option {
	return func(s *Service) { s.now = now }
}

// New returns the service over db. publicOrigin is where visitors reach the
// server, for example https://falky.example; links are built on it. After applying
// migrations, call InitializeColours and check its error before serving requests.
func New(db *platform.DB, publicOrigin string, opts ...Option) *Service {
	s := &Service{db: db, origin: publicOrigin, now: time.Now, reservations: newReservations(), connected: make(map[string]bool), chooseColour: func(n int) int {
		value, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
		if err != nil {
			panic("colour randomness: " + err.Error())
		}
		return int(value.Int64())
	}}
	s.signInCode = randomSignInCode
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

// Rotate preserves the legacy guest-link entry point. Realtime callers should
// use RotateWithEffects to enforce selective guest disconnection after commit.
func (s *Service) Rotate(ctx context.Context) (string, error) {
	link, _, err := s.RotateWithEffects(ctx)
	return link, err
}

func (s *Service) RotateWithEffects(ctx context.Context) (string, Effects, error) {
	secret := rand.Text()
	var effects Effects
	accounts := map[string]bool{}
	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, "SELECT identity_id FROM accounts")
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return err
			}
			accounts[id] = true
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return err
		}
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
		if err != nil {
			return err
		}
		return tx.QueryRowContext(ctx, "SELECT generation FROM access WHERE id=1").Scan(&effects.GuestGeneration)
	})
	if errors.Is(err, ErrNoLink) {
		return "", Effects{}, err
	}
	if err != nil {
		return "", Effects{}, fmt.Errorf("rotate access link: %w", err)
	}
	for key, hold := range s.reservations.held {
		if !accounts[hold.visitorID] {
			delete(s.reservations.held, key)
		}
	}
	return s.linkTo(secret), effects, nil
}
