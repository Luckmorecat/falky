package identity

import (
	"context"
	"database/sql"
)

// PurgeSignIns reclaims sanitized, expired history in small transactions. It
// never changes session authority and runs outside the transport lifecycle gate.
func (s *Service) PurgeSignIns(ctx context.Context) error {
	const batchSize = 128
	deadline := s.now().Unix()
	for _, query := range []string{
		`DELETE FROM account_signin_requests WHERE id IN (
			SELECT id FROM account_signin_requests WHERE expires_at<=?
			AND state IN ('denied','cancelled') AND browser_token_hash IS NULL
			AND code IS NULL AND qr_token_hash IS NULL AND delivery_ciphertext IS NULL ORDER BY expires_at LIMIT ?)`,
		`DELETE FROM account_signin_links WHERE id IN (
			SELECT id FROM account_signin_links WHERE expires_at<=? AND token_hash IS NULL
			AND state IN ('revoked','consumed')
			AND NOT EXISTS(SELECT 1 FROM account_signin_requests r WHERE r.link_id=account_signin_links.id) LIMIT ?)`,
	} {
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			var deleted int64
			if err := s.db.Write(ctx, func(tx *sql.Tx) error {
				result, err := tx.ExecContext(ctx, query, deadline, batchSize)
				if err != nil {
					return err
				}
				deleted, err = result.RowsAffected()
				return err
			}); err != nil {
				return err
			}
			if deleted < batchSize {
				break
			}
		}
	}
	return nil
}
