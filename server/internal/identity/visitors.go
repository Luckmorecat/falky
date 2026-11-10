package identity

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
)

// Visitor is the stable identity that owns messages and attachments.
type Visitor struct {
	// ID is a ULID; it never changes.
	ID     string
	Name   string
	Colour Colour
}

// ErrNoVisitor reports a token, or an identity ID, that gives no access:
// unknown, logged out, expired, revoked or of a disabled account.
var ErrNoVisitor = errors.New("no such visitor")

// Resolve returns the identity of a current account session cookie.
func (s *Service) Resolve(ctx context.Context, token string) (Visitor, error) {
	session, err := s.ResolveSession(ctx, token)
	return session.Visitor, err
}

// Visitor looks up an identity with current access. Admission for a specific
// live or voice connection must use ValidateSession instead.
func (s *Service) Visitor(ctx context.Context, visitorID string) (Visitor, error) {
	var sessionID string
	err := s.db.Read().QueryRowContext(ctx, "SELECT t.id "+currentSessions+" AND t.identity_id=? LIMIT 1", s.now().Unix(), visitorID).Scan(&sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return Visitor{}, ErrNoVisitor
	}
	if err != nil {
		return Visitor{}, fmt.Errorf("look up identity: %w", err)
	}
	session, err := s.sessionByID(ctx, s.db.Read(), sessionID)
	return session.Visitor, err
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
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM accounts WHERE identity_id=?)", visitorID).Scan(&isAccount); err != nil {
			return err
		}
		if isAccount {
			if err := s.claimName(ctx, tx, visitorID, name, &effects); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, "UPDATE accounts SET name_key=? WHERE identity_id=?", key, visitorID)
			return err
		}
		if s.reservations.takenBy(key, visitorID, s.now()) {
			return ErrNameTaken
		}
		res, err := tx.ExecContext(ctx, "UPDATE identities SET name = ? WHERE id = ?", name, visitorID)
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
	err = s.db.Read().QueryRowContext(ctx, "SELECT palette, revision FROM profiles WHERE identity_id = ?", visitorID).Scan(&colour.Palette, &colour.Revision)
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
	err = s.db.Read().QueryRowContext(ctx, "SELECT name FROM identities WHERE id = ?", visitorID).Scan(&name)
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
