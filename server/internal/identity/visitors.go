package identity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"

	"github.com/oklog/ulid/v2"
)

// Visitor is a person who entered through the access link.
type Visitor struct {
	// ID is a ULID; it never changes.
	ID   string
	Name string
}

// ErrWrongSecret reports a secret that is not the current access link's.
var ErrWrongSecret = errors.New("wrong access link secret")

// ErrNoVisitor reports a token, or a visitor ID, that gives no access: unknown,
// or issued under a link that has since been replaced.
var ErrNoVisitor = errors.New("no such visitor")

// Enter admits a new visitor named name when secret is the current access
// link's, and reserves the name for them. It returns the visitor and the
// token their cookie holds; only the token's hash is stored.
//
// It fails with ErrWrongSecret, an ErrInvalidName, or ErrNameTaken. The secret
// is checked first, so a caller without it learns nothing about names.
func (s *Service) Enter(ctx context.Context, secret, name string) (Visitor, string, error) {
	name, nameErr := CleanName(name)
	key := NameKey(name)
	v := Visitor{ID: ulid.Make().String(), Name: name}
	token := rand.Text()

	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	now := s.now()
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		var current string
		var generation int64
		if err := tx.QueryRowContext(ctx, "SELECT link_secret, generation FROM access WHERE id = 1").
			Scan(&current, &generation); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNoLink
			}
			return err
		}
		// Comparing the hashes takes the same time whatever the secrets are.
		want, got := sha256.Sum256([]byte(current)), sha256.Sum256([]byte(secret))
		if subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
			return ErrWrongSecret
		}
		if nameErr != nil {
			return nameErr
		}
		if s.reservations.takenBy(key, v.ID, now) {
			return ErrNameTaken
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO visitors (id, name, created_at)
			VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, v.ID, v.Name); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO visitor_tokens (token_hash, visitor_id, generation, created_at)
			VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, hashToken(token), v.ID, generation)
		return err
	})
	if err != nil {
		if errors.Is(err, ErrWrongSecret) || errors.Is(err, ErrInvalidName) || errors.Is(err, ErrNameTaken) {
			return Visitor{}, "", err
		}
		return Visitor{}, "", fmt.Errorf("enter: %w", err)
	}
	s.reservations.reserve(key, v.ID, now)
	return v, token, nil
}

// Resolve returns the visitor whose cookie holds token. A token issued under
// an earlier link generation, or an unknown one, fails with ErrNoVisitor.
func (s *Service) Resolve(ctx context.Context, token string) (Visitor, error) {
	if token == "" {
		return Visitor{}, ErrNoVisitor
	}
	var v Visitor
	err := s.db.Read().QueryRowContext(ctx, `SELECT v.id, v.name
		FROM visitor_tokens t
		JOIN visitors v ON v.id = t.visitor_id
		JOIN access a ON a.id = 1 AND a.generation = t.generation
		WHERE t.token_hash = ?`, hashToken(token)).Scan(&v.ID, &v.Name)
	if errors.Is(err, sql.ErrNoRows) {
		return Visitor{}, ErrNoVisitor
	}
	if err != nil {
		return Visitor{}, fmt.Errorf("resolve visitor: %w", err)
	}
	return v, nil
}

// HasAccess reports whether visitorID is a visitor with current access: one
// holding a token issued under the current link generation.
func (s *Service) HasAccess(ctx context.Context, visitorID string) (bool, error) {
	var ok bool
	err := s.db.Read().QueryRowContext(ctx, `SELECT EXISTS (SELECT 1
		FROM visitor_tokens t
		JOIN access a ON a.id = 1 AND a.generation = t.generation
		WHERE t.visitor_id = ?)`, visitorID).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("check visitor access: %w", err)
	}
	return ok, nil
}

// Rename changes the name of the visitor visitorID to name, and moves the
// name the visitor holds, if any, to it. It fails with an ErrInvalidName,
// ErrNameTaken, or ErrNoVisitor for an unknown visitor. The visitor's own
// name is free to them unless another visitor holds it.
func (s *Service) Rename(ctx context.Context, visitorID, name string) (Visitor, error) {
	name, err := CleanName(name)
	if err != nil {
		return Visitor{}, err
	}
	key := NameKey(name)

	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	if s.reservations.takenBy(key, visitorID, s.now()) {
		return Visitor{}, ErrNameTaken
	}
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, "UPDATE visitors SET name = ? WHERE id = ?", name, visitorID)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err == nil && n == 0 {
			return ErrNoVisitor
		}
		return err
	})
	if errors.Is(err, ErrNoVisitor) {
		return Visitor{}, err
	}
	if err != nil {
		return Visitor{}, fmt.Errorf("rename visitor: %w", err)
	}
	s.reservations.move(key, visitorID)
	return Visitor{ID: visitorID, Name: name}, nil
}

// Connect counts a live-update connection of the visitor visitorID, who is
// connected while they have one: a connected visitor holds their name, and a
// connection that opens takes over the reservation from entering. The caller
// calls disconnect once the connection has ended, saying whether it opened:
// one whose upgrade failed leaves the reservation as it was.
//
// It fails with ErrNameTaken when another visitor holds the visitor's name,
// or ErrNoVisitor for an unknown visitor. Checking the name and holding it
// are one step, so two visitors with the same name cannot both connect.
func (s *Service) Connect(ctx context.Context, visitorID string) (disconnect func(opened bool), err error) {
	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	// Rename writes names while holding the lock, so this one is current.
	var name string
	err = s.db.Read().QueryRowContext(ctx, "SELECT name FROM visitors WHERE id = ?", visitorID).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoVisitor
	}
	if err != nil {
		return nil, fmt.Errorf("connect visitor: %w", err)
	}
	key := NameKey(name)
	if s.reservations.takenBy(key, visitorID, s.now()) {
		return nil, ErrNameTaken
	}
	s.reservations.connect(key, visitorID)
	return func(opened bool) {
		s.reservations.mu.Lock()
		defer s.reservations.mu.Unlock()
		s.reservations.disconnect(visitorID, opened, s.now())
	}, nil
}

// NameTaken reports whether a visitor other than v holds v's name, as happens
// to a visitor who returns after another took their name while they were
// away. Connect refuses such a visitor until they rename.
func (s *Service) NameTaken(v Visitor) bool {
	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	return s.reservations.takenBy(NameKey(v.Name), v.ID, s.now())
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
