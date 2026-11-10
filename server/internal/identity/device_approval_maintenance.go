package identity

import (
	"context"
	"database/sql"
	"errors"
)

// MaintainSignIns prunes authorization and bounded delivery material. Call under
// the transport lifecycle gate; enforce returned effects before external cleanup.
func (s *Service) MaintainSignIns(ctx context.Context) (Effects, error) {
	var e Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, "SELECT id,identity_id,account_id,generation,expires_at FROM sessions WHERE id NOT IN (SELECT t.id "+currentSessions+")", s.now().Unix())
		if err != nil {
			return err
		}
		var stale []Session
		for rows.Next() {
			var session Session
			var identityID string
			var account sql.NullString
			var expires int64
			if err = rows.Scan(&session.ID, &identityID, &account, &session.Generation, &expires); err != nil {
				_ = rows.Close()
				return err
			}
			session.Kind = Guest
			if account.Valid {
				session.Kind = Account
			}
			session.ExpiresAt = unixTime(expires)
			session.Visitor, err = s.visitorRecord(ctx, tx, identityID)
			if err != nil {
				_ = rows.Close()
				return err
			}
			stale = append(stale, session)
		}
		if err = errors.Join(rows.Err(), rows.Close()); err != nil {
			return err
		}
		for _, session := range stale {
			if err = s.cancelSessionApprovals(ctx, tx, session.ID, &e); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", session.ID); err != nil {
				return err
			}
			e.RevokedSessions = append(e.RevokedSessions, session)
		}
		if err = s.cancelLinks(ctx, tx, &e, "expires_at<=? AND state IN ('open','approved')", s.now().Unix()); err != nil {
			return err
		}
		notified := make(map[string]bool, len(e.SignInChanges))
		for _, change := range e.SignInChanges {
			notified[change.Request.ID] = true
		}
		expired, err := signInRequests(ctx, tx, "expires_at<=? AND state!='consumed'", s.now().Unix())
		if err != nil {
			return err
		}
		for _, r := range expired {
			if notified[r.ID] {
				continue
			}
			if r.State == "pending" || r.State == "approved" {
				err = s.cancelRequest(ctx, tx, &e, r.ID, true)
			} else {
				err = s.appendRequestChange(ctx, tx, &e, r.ID, true)
			}
			if err != nil {
				return err
			}
		}

		if _, err = tx.ExecContext(ctx, "UPDATE account_signin_requests SET browser_token_hash=NULL,code=NULL,qr_token_hash=NULL,delivery_ciphertext=NULL WHERE expires_at<=?", s.now().Unix()); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE account_signin_links SET token_hash=NULL WHERE expires_at<=?", s.now().Unix()); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM account_signin_requests WHERE expires_at<=? AND state!='consumed'", s.now().Unix()); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "DELETE FROM account_signin_links WHERE (expires_at<=? OR state IN ('revoked','consumed')) AND NOT EXISTS(SELECT 1 FROM account_signin_requests r WHERE r.link_id=account_signin_links.id)", s.now().Unix())
		return err
	})
	if err != nil {
		return Effects{}, err
	}
	return e, nil
}
