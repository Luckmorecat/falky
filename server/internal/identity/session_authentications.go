package identity

import (
	"context"
	"database/sql"
)

type sessionAuthentication struct {
	method           string
	authenticatedAt  int64
	credential       []byte
	requestID        string
	originCredential []byte
	recentProof      bool
}

func (s *Service) recordAuthentication(ctx context.Context, tx *sql.Tx, sessionID, purpose string, auth sessionAuthentication) error {
	if auth.authenticatedAt > s.now().Unix() {
		return ErrInvalidProof
	}
	var requestID any
	if auth.requestID != "" {
		requestID = auth.requestID
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO session_authentications(session_id,method,purpose,authenticated_at,passkey_credential_id,device_approval_request_id,origin_passkey_credential_id,recent_proof) VALUES(?,?,?,?,?,?,?,?)`, sessionID, auth.method, purpose, auth.authenticatedAt, auth.credential, requestID, auth.originCredential, auth.recentProof)
	return err
}

// Only the latest event can authorize a sensitive action. Missing evidence never
// resurrects an older event, including when both were recorded in one second.
// Legacy device-approval freshness flags never establish receiving-session proof.
func (s *Service) recentAuthentication(ctx context.Context, tx *sql.Tx, session Session) (bool, error) {
	var valid bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM session_authentications e
 LEFT JOIN passkeys p ON p.credential_id=e.passkey_credential_id AND p.identity_id=?
 WHERE e.id=(SELECT id FROM session_authentications WHERE session_id=? ORDER BY id DESC LIMIT 1)
 AND e.authenticated_at>? AND e.authenticated_at<=? AND e.recent_proof=1
 AND e.method='passkey' AND p.credential_id IS NOT NULL)`, session.Visitor.ID, session.ID, s.now().Add(-RecentProofTTL).Unix(), s.now().Unix()).Scan(&valid)
	return valid, err
}

func (s *Service) initialPasskeyOrigin(ctx context.Context, tx *sql.Tx, sessionID string) ([]byte, error) {
	var origin []byte
	err := tx.QueryRowContext(ctx, `SELECT CASE method WHEN 'passkey' THEN passkey_credential_id WHEN 'device_approval' THEN origin_passkey_credential_id END FROM session_authentications WHERE session_id=? AND purpose='sign_in'`, sessionID).Scan(&origin)
	return origin, err
}

// Keep dependency cancellation and terminal snapshots ahead of session FK cascades.
func (s *Service) revokeSession(ctx context.Context, tx *sql.Tx, session Session, effects *Effects) error {
	if err := s.cancelSessionApprovals(ctx, tx, session.ID, effects); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", session.ID); err != nil {
		return err
	}
	effects.RevokedSessions = append(effects.RevokedSessions, session)
	return nil
}

// Cancel before session FKs are cleared so unfinished approvals cannot lose
// their authorization dependency and remain redeemable.
func (s *Service) cancelSessionApprovals(ctx context.Context, tx *sql.Tx, sessionID string, effects *Effects) error {
	if err := s.cancelLinks(ctx, tx, effects, "issuer_session_id=? AND state IN ('open','approved')", sessionID); err != nil {
		return err
	}
	requests, err := signInRequests(ctx, tx, "approved_by_session_id=? AND state IN ('pending','approved')", sessionID)
	if err != nil {
		return err
	}
	for _, r := range requests {
		if err = s.cancelRequest(ctx, tx, effects, r.ID, true); err != nil {
			return err
		}
	}
	// Session deletion is the durable terminal transition for consumed history.
	// Capture a terminal hint before ON DELETE CASCADE removes the request.
	consumed, err := signInRequests(ctx, tx, "created_session_id=? AND state='consumed'", sessionID)
	if err != nil {
		return err
	}
	for _, r := range consumed {
		c, err := s.requestChange(ctx, tx, r.ID, true)
		if err != nil {
			return err
		}
		c.Request.State = "cancelled"
		c.Request.Version++
		effects.SignInChanges = append(effects.SignInChanges, c)
	}
	return nil
}
