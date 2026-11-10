package identity

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// AccessPassTTL is how long a browser that gave the access password may sign
// in or register without giving it again.
const AccessPassTTL = 400 * 24 * time.Hour

// SetAccessPassword makes password the access password. The previous one, and
// every pass issued under it, stop working; signed-in sessions are unaffected.
func (s *Service) SetAccessPassword(ctx context.Context, password string) error {
	if err := checkPasswordRules(password); err != nil {
		return err
	}
	hash, err := s.hashPassword(password)
	if err != nil {
		return err
	}
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO access_password (id, password_hash, generation, set_at) VALUES (1, ?, 1, ?)
			ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash, generation = generation + 1, set_at = excluded.set_at`,
			hash, s.now().Unix()); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "DELETE FROM access_passes")
		return err
	})
	if err != nil {
		return fmt.Errorf("set access password: %w", err)
	}
	return nil
}

// AccessPasswordSet reports whether the operator has set the access password.
func (s *Service) AccessPasswordSet(ctx context.Context) (bool, error) {
	var set bool
	err := s.db.Read().QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM access_password)").Scan(&set)
	return set, err
}

// PassAccess checks password against the access password and returns the
// token of a new pass. It fails with ErrAccessUnset or ErrWrongAccessPassword.
func (s *Service) PassAccess(ctx context.Context, password string) (string, error) {
	var hash string
	var generation int64
	err := s.db.Read().QueryRowContext(ctx, "SELECT password_hash, generation FROM access_password WHERE id = 1").Scan(&hash, &generation)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrAccessUnset
	}
	if err != nil {
		return "", fmt.Errorf("read access password: %w", err)
	}
	if !s.passwordMatches(hash, password) {
		return "", ErrWrongAccessPassword
	}
	token := opaque()
	now := s.now()
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		// A pass is only valid under the generation it was checked against;
		// a password changed meanwhile leaves it dead on arrival.
		_, err := tx.ExecContext(ctx, "DELETE FROM access_passes WHERE expires_at <= ?", now.Unix())
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO access_passes (token_hash, generation, expires_at) VALUES (?, ?, ?)",
			hashToken(token), generation, now.Add(AccessPassTTL).Unix())
		return err
	})
	if err != nil {
		return "", fmt.Errorf("issue access pass: %w", err)
	}
	return token, nil
}

// AccessPassed reports whether token is a pass for the current access
// password that has not expired.
func (s *Service) AccessPassed(ctx context.Context, token string) (bool, error) {
	return s.accessPassed(ctx, s.db.Read(), token)
}

func (s *Service) accessPassed(ctx context.Context, q queryer, token string) (bool, error) {
	if token == "" {
		return false, nil
	}
	var passed bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM access_passes p JOIN access_password a ON a.id = 1 AND a.generation = p.generation
		WHERE p.token_hash = ? AND p.expires_at > ?)`, hashToken(token), s.now().Unix()).Scan(&passed)
	return passed, err
}

// LegacyGuest returns the identity of a guest session from before accounts
// replaced guests. Such a session admits nothing any more; it only lets its
// holder register an account that keeps the guest's identity and history.
func (s *Service) LegacyGuest(ctx context.Context, token string) (Visitor, error) {
	return s.legacyGuest(ctx, s.db.Read(), token)
}

func (s *Service) legacyGuest(ctx context.Context, q queryer, token string) (Visitor, error) {
	if token == "" {
		return Visitor{}, ErrNoVisitor
	}
	var id string
	err := q.QueryRowContext(ctx, `SELECT t.identity_id FROM sessions t JOIN access g ON g.id = 1 AND g.generation = t.generation
		WHERE t.token_hash = ? AND t.account_id IS NULL AND t.expires_at > ?
		AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.identity_id = t.identity_id)`, hashToken(token), s.now().Unix()).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Visitor{}, ErrNoVisitor
	}
	if err != nil {
		return Visitor{}, err
	}
	return s.visitorRecord(ctx, q, id)
}
