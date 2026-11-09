package identity

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

type RecoveryGrant struct {
	Token     string
	Link      string
	AccountID string
	ExpiresAt time.Time
}

// IssueRecovery grants only enrollment of a replacement passkey. Issuance
// changes no existing authorization; callers must verify the human out of band.
func (s *Service) IssueRecovery(ctx context.Context, accountID string) (RecoveryGrant, error) {
	g := RecoveryGrant{Token: opaque(), AccountID: accountID, ExpiresAt: s.now().Add(OperatorRecoveryTTL).UTC()}
	g.Link = s.origin + "/#recover=" + g.Token + "&account=" + accountID
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		_, generation, err := s.user(ctx, tx, accountID)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO account_recovery_proofs(token_hash,identity_id,kind,generation,expires_at) VALUES(?,?,'operator',?,?)", hashToken(g.Token), accountID, generation, g.ExpiresAt.Unix())
		return err
	})
	if err != nil {
		return RecoveryGrant{}, err
	}
	return g, nil
}

func (s *Service) recoveryProof(ctx context.Context, tx *sql.Tx, accountID string, hash []byte) error {
	var valid bool
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM account_recovery_proofs p JOIN accounts a ON a.identity_id=p.identity_id AND a.generation=p.generation AND a.disabled=0 WHERE p.identity_id=? AND p.token_hash=? AND (p.expires_at IS NULL OR p.expires_at>?))", accountID, hash, s.now().Unix()).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrInvalidProof
	}
	return nil
}

func (s *Service) BeginRecovery(ctx context.Context, accountID, proof, browser string) (Ceremony, error) {
	if browser == "" || proof == "" {
		return Ceremony{}, ErrInvalidProof
	}
	var c Ceremony
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		if err := s.recoveryProof(ctx, tx, accountID, hashToken(proof)); err != nil {
			return err
		}
		u, _, err := s.user(ctx, tx, accountID)
		if err != nil {
			return err
		}
		w, err := s.verifier()
		if err != nil {
			return err
		}
		options, data, err := w.BeginRegistration(u, webauthn.WithExtensions(webauthn.WithExtensionCredProps()))
		if err != nil {
			return err
		}
		c = Ceremony{ID: opaque(), ExpiresAt: s.now().Add(CeremonyTTL), Creation: options}
		return s.storeCeremony(ctx, tx, c, browser, "recover", u, "", hashToken(proof), data)
	})
	return c, err
}

func (s *Service) FinishRecovery(ctx context.Context, id, browser string, response []byte, label string) (Enrollment, error) {
	var result Enrollment
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		c, err := s.loadCeremony(ctx, tx, id, browser, "recover")
		if err != nil {
			return err
		}
		if err = s.recoveryProof(ctx, tx, c.id, c.proof); err != nil {
			return err
		}
		u, generation, err := s.user(ctx, tx, c.id)
		if err != nil {
			return err
		}
		credential, err := s.verifyCreation(u, c.data, response)
		if err != nil {
			return err
		}
		if err = s.availableCredential(ctx, tx, credential.ID); err != nil {
			return err
		}
		result.Effects, err = s.accountEffects(ctx, tx, c.id, generation+1, false)
		if err != nil {
			return err
		}
		for _, table := range []string{"passkeys", "sessions", "account_recovery_proofs", "account_ceremonies"} {
			if _, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE identity_id=?", c.id); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE accounts SET generation=generation+1 WHERE identity_id=?", c.id); err != nil {
			return err
		}
		if err = s.insertCredential(ctx, tx, c.id, label, credential); err != nil {
			return err
		}
		result.RecoveryCodes, err = s.replaceCodes(ctx, tx, c.id, generation+1)
		if err != nil {
			return err
		}
		result.Session, result.Token, err = s.issueSession(ctx, tx, c.id, Account, credential.ID)
		return err
	})
	if err != nil {
		return Enrollment{}, err
	}
	return result, nil
}

func (s *Service) accountEffects(ctx context.Context, tx *sql.Tx, id string, generation int64, disabled bool) (Effects, error) {
	e := Effects{RevokedIdentity: id, SecurityGeneration: generation, AccountDisabled: disabled}
	v, err := s.visitorRecord(ctx, tx, id)
	if err != nil {
		return Effects{}, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,generation,expires_at FROM sessions WHERE identity_id=? AND account_id IS NOT NULL", id)
	if err != nil {
		return Effects{}, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		session := Session{Visitor: v, Kind: Account}
		var expires int64
		if err := rows.Scan(&session.ID, &session.Generation, &expires); err != nil {
			return Effects{}, err
		}
		session.ExpiresAt = unixTime(expires)
		e.RevokedSessions = append(e.RevokedSessions, session)
	}
	return e, rows.Err()
}

func (s *Service) DisableAccount(ctx context.Context, accountID string) (Effects, error) {
	var effects Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		var generation int64
		if err := tx.QueryRowContext(ctx, "SELECT generation FROM accounts WHERE identity_id=?", accountID).Scan(&generation); errors.Is(err, sql.ErrNoRows) {
			return ErrNoVisitor
		} else if err != nil {
			return err
		}
		var err error
		effects, err = s.accountEffects(ctx, tx, accountID, generation+1, true)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE accounts SET disabled=1,generation=generation+1 WHERE identity_id=?", accountID); err != nil {
			return err
		}
		for _, table := range []string{"sessions", "account_recovery_proofs", "account_ceremonies"} {
			if _, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE identity_id=?", accountID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Effects{}, err
	}
	return effects, nil
}

type AccountInfo struct {
	ID         string
	Name       string
	Disabled   bool
	Generation int64
}

func (s *Service) AccountInfo(ctx context.Context, id string) (AccountInfo, error) {
	var a AccountInfo
	err := s.db.Read().QueryRowContext(ctx, "SELECT v.id,v.name,a.disabled,a.generation FROM accounts a JOIN identities v ON v.id=a.identity_id WHERE a.identity_id=?", id).Scan(&a.ID, &a.Name, &a.Disabled, &a.Generation)
	if errors.Is(err, sql.ErrNoRows) {
		return AccountInfo{}, ErrNoVisitor
	}
	return a, err
}

// Accounts lists account references for the protected operator transport.
func (s *Service) Accounts(ctx context.Context) ([]AccountInfo, error) {
	rows, err := s.db.Read().QueryContext(ctx, "SELECT v.id,v.name,a.disabled,a.generation FROM accounts a JOIN identities v ON v.id=a.identity_id ORDER BY a.created_at,v.id")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := []AccountInfo{}
	for rows.Next() {
		var a AccountInfo
		if err := rows.Scan(&a.ID, &a.Name, &a.Disabled, &a.Generation); err != nil {
			return nil, err
		}
		result = append(result, a)
	}
	return result, rows.Err()
}
