// Package identity owns persistent identities, the access password and the
// password accounts people sign in with.
package identity

import (
	"crypto/rand"
	"embed"
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

// concurrentHashes bounds how many Argon2id hashes run at once, each taking
// the cost's memory.
const concurrentHashes = 4

// Service manages the access password, accounts and their sessions. Connected
// name holds live in memory, so the server uses one Service for every request.
type Service struct {
	db           *platform.DB
	origin       string
	now          func() time.Time
	reservations *reservations
	colourMu     sync.Mutex
	connected    map[string]bool
	chooseColour func(int) int
	passwordCost PasswordCost
	hashing      chan struct{}
}

// Option changes how New sets up the Service.
type Option func(*Service)

// WithClock makes the Service read the time from now instead of the system
// clock.
func WithClock(now func() time.Time) Option {
	return func(s *Service) { s.now = now }
}

// New returns the service over db. publicOrigin is where people reach the
// server, for example https://falky.example; links are built on it. After applying
// migrations, call InitializeColours and check its error before serving requests.
func New(db *platform.DB, publicOrigin string, opts ...Option) *Service {
	s := &Service{
		db: db, origin: publicOrigin, now: time.Now, reservations: newReservations(), connected: make(map[string]bool),
		chooseColour: func(n int) int {
			value, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
			if err != nil {
				panic("colour randomness: " + err.Error())
			}
			return int(value.Int64())
		},
		passwordCost: DefaultPasswordCost,
		hashing:      make(chan struct{}, concurrentHashes),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}
