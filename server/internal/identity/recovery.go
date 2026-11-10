package identity

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"time"
)

// RecoveryGrant is a one-time operator recovery code for one account.
type RecoveryGrant struct {
	Token     string
	Link      string
	AccountID string
	ExpiresAt time.Time
}

// RecoveryInput is what recovering an account takes: the access pass, the
// account's login or ID, the operator's recovery code, the new password, and
// a login when the account should get a new one. An account from before
// passwords has no login and must be given one.
type RecoveryInput struct {
	AccessToken string
	Account     string
	Proof       string
	Password    string
	Login       string
}

// IssueRecovery grants one recovery of the account ref (a login or an ID)
// within OperatorRecoveryTTL. Issuance changes no existing authorization;
// callers must verify the human out of band.
func (s *Service) IssueRecovery(ctx context.Context, ref string) (RecoveryGrant, error) {
	g := RecoveryGrant{Token: opaque(), ExpiresAt: s.now().Add(OperatorRecoveryTTL).UTC()}
	var login sql.NullString
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		id, err := s.accountRef(ctx, tx, ref)
		if err != nil {
			return err
		}
		var generation int64
		var disabled bool
		if err := tx.QueryRowContext(ctx, "SELECT generation,disabled,login_key FROM accounts WHERE identity_id=?", id).Scan(&generation, &disabled, &login); err != nil {
			return err
		}
		if disabled {
			return ErrDisabled
		}
		g.AccountID = id
		_, err = tx.ExecContext(ctx, "INSERT INTO account_recovery_proofs(token_hash,identity_id,kind,generation,expires_at) VALUES(?,?,'operator',?,?)", hashToken(g.Token), id, generation, g.ExpiresAt.Unix())
		return err
	})
	if err != nil {
		return RecoveryGrant{}, err
	}
	account := g.AccountID
	if login.Valid {
		account = login.String
	}
	g.Link = s.origin + "/#recover=" + url.QueryEscape(g.Token) + "&account=" + url.QueryEscape(account)
	return g, nil
}

func (s *Service) recoveryProof(ctx context.Context, q queryer, accountID string, hash []byte) error {
	var valid bool
	err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM account_recovery_proofs p JOIN accounts a ON a.identity_id=p.identity_id AND a.generation=p.generation AND a.disabled=0 WHERE p.identity_id=? AND p.token_hash=? AND p.kind='operator' AND p.expires_at>?)", accountID, hash, s.now().Unix()).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrInvalidProof
	}
	return nil
}

// operatorProof fails with ErrInvalidProof unless code is a current operator
// recovery code of account id, given exactly as issued.
func (s *Service) operatorProof(ctx context.Context, q queryer, id, code string) error {
	if code == "" {
		return ErrInvalidProof
	}
	return s.recoveryProof(ctx, q, id, hashToken(code))
}

// Recover sets a new password, and a new login when given one, on the
// account in.Account, given an operator recovery code. It ends every old
// session and recovery code and signs this browser in.
//
// It fails with ErrAccessRequired, ErrInvalidProof (also for an unknown or
// disabled account), ErrInvalidPassword, ErrInvalidLogin, ErrLoginTaken or
// ErrLoginRequired.
func (s *Service) Recover(ctx context.Context, in RecoveryInput) (Enrollment, error) {
	passed, err := s.AccessPassed(ctx, in.AccessToken)
	if err != nil {
		return Enrollment{}, err
	}
	if !passed {
		return Enrollment{}, ErrAccessRequired
	}
	id, err := s.accountRef(ctx, s.db.Read(), in.Account)
	if errors.Is(err, ErrNoVisitor) {
		return Enrollment{}, ErrInvalidProof
	}
	if err != nil {
		return Enrollment{}, err
	}
	if err := s.operatorProof(ctx, s.db.Read(), id, in.Proof); err != nil {
		return Enrollment{}, err
	}
	if err := checkPasswordRules(in.Password); err != nil {
		return Enrollment{}, err
	}
	var login string
	if in.Login != "" {
		if login, err = CleanLogin(in.Login); err != nil {
			return Enrollment{}, err
		}
	}
	hash, err := s.hashPassword(in.Password)
	if err != nil {
		return Enrollment{}, err
	}
	var result Enrollment
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		if err := s.operatorProof(ctx, tx, id, in.Proof); err != nil {
			return err
		}
		var generation int64
		var current sql.NullString
		if err := tx.QueryRowContext(ctx, "SELECT generation,login_key FROM accounts WHERE identity_id=?", id).Scan(&generation, &current); err != nil {
			return err
		}
		if login == "" {
			if !current.Valid {
				return ErrLoginRequired
			}
			login = current.String
		}
		if err := s.loginFree(ctx, tx, login, id); err != nil {
			return err
		}
		var err error
		result.Effects, err = s.accountEffects(ctx, tx, id, generation+1, false)
		if err != nil {
			return err
		}
		for _, table := range []string{"sessions", "account_recovery_proofs"} {
			if _, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE identity_id=?", id); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE accounts SET generation=generation+1,password_hash=?,login_key=? WHERE identity_id=?", hash, login, id); err != nil {
			return err
		}
		result.Session, result.Token, err = s.issueSession(ctx, tx, id)
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

// DisableAccount ends the access of the account ref (a login or an ID) and
// keeps its identity, name and messages.
func (s *Service) DisableAccount(ctx context.Context, ref string) (Effects, error) {
	var effects Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		accountID, err := s.accountRef(ctx, tx, ref)
		if err != nil {
			return err
		}
		var generation int64
		if err := tx.QueryRowContext(ctx, "SELECT generation FROM accounts WHERE identity_id=?", accountID).Scan(&generation); err != nil {
			return err
		}
		effects, err = s.accountEffects(ctx, tx, accountID, generation+1, true)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE accounts SET disabled=1,generation=generation+1 WHERE identity_id=?", accountID); err != nil {
			return err
		}
		for _, table := range []string{"sessions", "account_recovery_proofs"} {
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

// EnableAccount lets the disabled account ref (a login or an ID) sign in
// again with its password.
func (s *Service) EnableAccount(ctx context.Context, ref string) error {
	return s.db.Write(ctx, func(tx *sql.Tx) error {
		accountID, err := s.accountRef(ctx, tx, ref)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE accounts SET disabled=0 WHERE identity_id=?", accountID)
		return err
	})
}

// AccountInfo is an account as the operator sees it. Login is empty for an
// account from before passwords that has not recovered yet.
type AccountInfo struct {
	ID         string `json:"id"`
	Login      string `json:"login"`
	Name       string `json:"name"`
	Disabled   bool   `json:"disabled"`
	Generation int64  `json:"generation"`
}

const accountInfoColumns = "SELECT v.id,coalesce(a.login_key,''),v.name,a.disabled,a.generation FROM accounts a JOIN identities v ON v.id=a.identity_id"

func (s *Service) AccountInfo(ctx context.Context, id string) (AccountInfo, error) {
	var a AccountInfo
	err := s.db.Read().QueryRowContext(ctx, accountInfoColumns+" WHERE a.identity_id=?", id).Scan(&a.ID, &a.Login, &a.Name, &a.Disabled, &a.Generation)
	if errors.Is(err, sql.ErrNoRows) {
		return AccountInfo{}, ErrNoVisitor
	}
	return a, err
}

// Accounts lists every account for the protected operator transport.
func (s *Service) Accounts(ctx context.Context) ([]AccountInfo, error) {
	rows, err := s.db.Read().QueryContext(ctx, accountInfoColumns+" ORDER BY a.created_at,v.id")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := []AccountInfo{}
	for rows.Next() {
		var a AccountInfo
		if err := rows.Scan(&a.ID, &a.Login, &a.Name, &a.Disabled, &a.Generation); err != nil {
			return nil, err
		}
		result = append(result, a)
	}
	return result, rows.Err()
}
