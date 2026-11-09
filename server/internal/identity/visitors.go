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

// Visitor is the stable identity shared by guests and accounts.
type Visitor struct {
	// ID is a ULID; it never changes.
	ID     string
	Name   string
	Colour Colour
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
		if err := s.reservedName(ctx, tx, key, v.ID); err != nil {
			return err
		}
		if s.reservations.takenBy(key, v.ID, now) {
			return ErrNameTaken
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO visitors (id, name, created_at)
			VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, v.ID, v.Name); err != nil {
			return err
		}
		var err error
		v.Colour, err = s.allocateColour(ctx, tx, v.ID)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO visitor_tokens (token_hash, visitor_id, generation, created_at)
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

// Resolve returns the current identity for a valid guest or account cookie.
func (s *Service) Resolve(ctx context.Context, token string) (Visitor, error) {
	session, err := s.ResolveSession(ctx, token)
	return session.Visitor, err
}

// Visitor looks up an identity with current access. Admission for a specific
// live or voice connection must use ValidateSession instead.
func (s *Service) Visitor(ctx context.Context, visitorID string) (Visitor, error) {
	var v Visitor
	err := s.db.Read().QueryRowContext(ctx, `SELECT v.id, v.name, c.palette, c.revision
		FROM visitors v JOIN visitor_colours c ON c.visitor_id = v.id
		WHERE v.id = ? AND ((EXISTS (SELECT 1 FROM accounts x WHERE x.visitor_id=v.id AND x.disabled=0)
		AND EXISTS (SELECT 1 FROM account_sessions t JOIN accounts a ON a.visitor_id=t.visitor_id AND a.generation=t.generation WHERE t.visitor_id=v.id AND t.expires_at>?))
		OR (NOT EXISTS(SELECT 1 FROM accounts x WHERE x.visitor_id=v.id) AND EXISTS (SELECT 1
			FROM visitor_tokens t
			JOIN access a ON a.id = 1 AND a.generation = t.generation
			WHERE t.visitor_id = v.id)))`, visitorID, s.now().Unix()).Scan(&v.ID, &v.Name, &v.Colour.Palette, &v.Colour.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return Visitor{}, ErrNoVisitor
	}
	if err != nil {
		return Visitor{}, fmt.Errorf("look up visitor: %w", err)
	}
	v.Colour.VisitorID = v.ID
	return v, nil
}

// Rename changes the name of the visitor visitorID to name, and moves the
// name the visitor holds, if any, to it. It fails with an ErrInvalidName,
// ErrNameTaken, or ErrNoVisitor for an unknown visitor. The visitor's own
// name is free to them unless another visitor holds it.
func (s *Service) Rename(ctx context.Context, visitorID, name string) (Visitor, error) {
	v, _, err := s.RenameWithEffects(ctx, visitorID, name)
	return v, err
}

// RenameWithEffects includes guests displaced by an account's durable claim.
func (s *Service) RenameWithEffects(ctx context.Context, visitorID, name string) (Visitor, Effects, error) {
	name, err := CleanName(name)
	if err != nil {
		return Visitor{}, Effects{}, err
	}
	key := NameKey(name)

	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	var effects Effects
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		if err := s.reservedName(ctx, tx, key, visitorID); err != nil {
			return err
		}
		var isAccount bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM accounts WHERE visitor_id=?)", visitorID).Scan(&isAccount); err != nil {
			return err
		}
		if isAccount {
			if err := s.claimName(ctx, tx, visitorID, name, &effects); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, "UPDATE accounts SET name_key=? WHERE visitor_id=?", key, visitorID)
			return err
		}
		if s.reservations.takenBy(key, visitorID, s.now()) {
			return ErrNameTaken
		}
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
		return Visitor{}, Effects{}, err
	}
	if err != nil {
		return Visitor{}, Effects{}, fmt.Errorf("rename visitor: %w", err)
	}
	s.applyNameEffects(effects)
	s.reservations.move(key, visitorID)
	var colour Colour
	err = s.db.Read().QueryRowContext(ctx, "SELECT palette, revision FROM visitor_colours WHERE visitor_id = ?", visitorID).Scan(&colour.Palette, &colour.Revision)
	if err != nil {
		return Visitor{}, Effects{}, fmt.Errorf("renamed visitor colour: %w", err)
	}
	colour.VisitorID = visitorID
	return Visitor{ID: visitorID, Name: name, Colour: colour}, effects, nil
}

// Connect counts a live-update connection of the visitor visitorID, who is
// connected while they have one: a connected visitor holds their name, and a
// connection that opens takes over the reservation from entering. The caller
// calls disconnect once the connection has ended, saying whether it opened:
// one whose upgrade failed leaves the visitor's own reservation as it was.
//
// It fails with ErrNameTaken when another connected visitor holds the
// visitor's name, or ErrNoVisitor for an unknown visitor. Another visitor's
// reservation from entering does not keep the visitor out: connecting ends
// it, and that visitor is then the one whose name is taken. Checking the name
// and holding it are one step, so two visitors with the same name cannot both
// connect.
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
	if err := s.reservedName(ctx, s.db.Read(), key, visitorID); err != nil {
		return nil, err
	}
	if s.reservations.takenByConnected(key, visitorID) {
		return nil, ErrNameTaken
	}
	s.reservations.connect(key, visitorID)
	return func(opened bool) {
		s.reservations.mu.Lock()
		defer s.reservations.mu.Unlock()
		s.reservations.disconnect(visitorID, opened, s.now())
	}, nil
}

// NameTaken reports whether another connected visitor holds v's name, as
// happens to a visitor who returns after another took their name while they
// were away. A reservation from entering does not count. Connect refuses such
// a visitor until they rename.
func (s *Service) NameTaken(v Visitor) bool {
	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	return s.reservations.takenByConnected(NameKey(v.Name), v.ID)
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
