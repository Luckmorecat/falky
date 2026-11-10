package identity

import (
	"context"
	"database/sql"
	"errors"
)

// ownerSession resolves token to a current account session within tx.
func (s *Service) ownerSession(ctx context.Context, tx *sql.Tx, token string) (Session, error) {
	var id string
	err := tx.QueryRowContext(ctx, "SELECT id FROM sessions WHERE token_hash=? AND account_id IS NOT NULL", hashToken(token)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNoVisitor
	}
	if err != nil {
		return Session{}, err
	}
	return s.sessionByID(ctx, tx, id)
}

// verifyOwnPassword fails with ErrNoVisitor unless token is a current account
// session, and with ErrWrongCredentials unless password is that account's.
func (s *Service) verifyOwnPassword(ctx context.Context, token, password string) (Session, error) {
	session, err := s.ResolveSession(ctx, token)
	if err != nil {
		return Session{}, err
	}
	var hash sql.NullString
	if err := s.db.Read().QueryRowContext(ctx, "SELECT password_hash FROM accounts WHERE identity_id=?", session.Visitor.ID).Scan(&hash); err != nil {
		return Session{}, err
	}
	if !s.passwordMatches(hash.String, password) {
		return Session{}, ErrWrongCredentials
	}
	return session, nil
}

// ChangePassword replaces the password of the account token signs in, given
// its current one. Every other session of the account ends; this one stays.
// It fails with ErrNoVisitor, ErrWrongCredentials or ErrInvalidPassword.
func (s *Service) ChangePassword(ctx context.Context, token, current, next string) (Effects, error) {
	if err := checkPasswordRules(next); err != nil {
		return Effects{}, err
	}
	session, err := s.verifyOwnPassword(ctx, token, current)
	if err != nil {
		return Effects{}, err
	}
	hash, err := s.hashPassword(next)
	if err != nil {
		return Effects{}, err
	}
	var effects Effects
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		owner, err := s.ownerSession(ctx, tx, token)
		if err != nil {
			return err
		}
		if owner.Visitor.ID != session.Visitor.ID {
			return ErrNoVisitor
		}
		if _, err := tx.ExecContext(ctx, "UPDATE accounts SET password_hash=? WHERE identity_id=?", hash, owner.Visitor.ID); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, "SELECT t.id "+currentSessions+" AND t.identity_id=? AND t.id<>?", s.now().Unix(), owner.Visitor.ID, owner.ID)
		if err != nil {
			return err
		}
		var others []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return err
			}
			others = append(others, id)
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return err
		}
		for _, id := range others {
			other, err := s.sessionByID(ctx, tx, id)
			if err != nil {
				return err
			}
			effects.RevokedSessions = append(effects.RevokedSessions, other)
		}
		_, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE identity_id=? AND id<>?", owner.Visitor.ID, owner.ID)
		return err
	})
	if err != nil {
		return Effects{}, err
	}
	return effects, nil
}

// Logout ends the session token holds.
func (s *Service) Logout(ctx context.Context, token string) (Effects, error) {
	var effects Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		var id string
		err := tx.QueryRowContext(ctx, "SELECT id FROM sessions WHERE token_hash=?", hashToken(token)).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNoVisitor
		}
		if err != nil {
			return err
		}
		current, err := s.sessionByID(ctx, tx, id)
		if err != nil {
			return err
		}
		effects.RevokedSessions = []Session{current}
		_, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", id)
		return err
	})
	if err != nil {
		return Effects{}, err
	}
	return effects, nil
}
