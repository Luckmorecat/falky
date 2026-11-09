package identity

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

func (s *Service) user(ctx context.Context, q queryer, id string) (accountUser, int64, error) {
	u := accountUser{id: id}
	var generation int64
	var disabled bool
	err := q.QueryRowContext(ctx, "SELECT v.name,a.generation,a.disabled FROM accounts a JOIN visitors v ON v.id=a.visitor_id WHERE a.visitor_id=?", id).Scan(&u.name, &generation, &disabled)
	if errors.Is(err, sql.ErrNoRows) {
		return u, 0, ErrNoVisitor
	}
	if err != nil {
		return u, 0, err
	}
	if disabled {
		return u, 0, ErrDisabled
	}
	rows, err := q.QueryContext(ctx, "SELECT credential FROM passkeys WHERE visitor_id=? ORDER BY created_at,credential_id", id)
	if err != nil {
		return u, 0, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var body string
		var credential webauthn.Credential
		if err := rows.Scan(&body); err != nil {
			return u, 0, err
		}
		if err := json.Unmarshal([]byte(body), &credential); err != nil {
			return u, 0, err
		}
		u.credentials = append(u.credentials, credential)
	}
	return u, generation, rows.Err()
}

func (s *Service) BeginAuthentication(ctx context.Context, browser string) (Ceremony, error) {
	if browser == "" {
		return Ceremony{}, ErrInvalidProof
	}
	w, err := s.verifier()
	if err != nil {
		return Ceremony{}, err
	}
	options, data, err := w.BeginDiscoverableLogin()
	if err != nil {
		return Ceremony{}, err
	}
	c := Ceremony{ID: opaque(), ExpiresAt: s.now().Add(CeremonyTTL), Assertion: options}
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		return s.storeCeremony(ctx, tx, c, browser, "authenticate", accountUser{}, "", nil, data)
	})
	return c, err
}

func (s *Service) FinishAuthentication(ctx context.Context, id, browser string, response []byte) (Enrollment, error) {
	var result Enrollment
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		c, err := s.loadCeremony(ctx, tx, id, browser, "authenticate")
		if err != nil {
			return err
		}
		parsed, err := protocol.ParseCredentialRequestResponseBytes(response)
		if err != nil {
			return invalidProof(err)
		}
		w, err := s.verifier()
		if err != nil {
			return err
		}
		verified, credential, err := w.ValidatePasskeyLogin(func(rawID, handle []byte) (webauthn.User, error) {
			u, _, err := s.user(ctx, tx, string(handle))
			return u, err
		}, c.data, parsed)
		if err != nil {
			return invalidProof(err)
		}
		if credential.Authenticator.CloneWarning {
			return ErrInvalidProof
		}
		if err = s.updateCredential(ctx, tx, verified.WebAuthnID(), credential); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM account_ceremonies WHERE id=?", id); err != nil {
			return err
		}
		result.Session, result.Token, err = s.issueSession(ctx, tx, string(verified.WebAuthnID()), credential.ID)
		return err
	})
	if err != nil {
		return Enrollment{}, err
	}
	return result, nil
}

func invalidProof(err error) error { return fmt.Errorf("%w: %w", ErrInvalidProof, err) }

func (s *Service) updateCredential(ctx context.Context, tx *sql.Tx, id []byte, credential *webauthn.Credential) error {
	body, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	r, err := tx.ExecContext(ctx, "UPDATE passkeys SET credential=? WHERE credential_id=? AND visitor_id=?", string(body), credential.ID, string(id))
	return affected(r, err, ErrInvalidProof)
}

func (s *Service) ownerSession(ctx context.Context, tx *sql.Tx, token string, recent bool) (Session, error) {
	var id string
	err := tx.QueryRowContext(ctx, "SELECT id FROM account_sessions WHERE token_hash=?", hashToken(token)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNoVisitor
	}
	if err != nil {
		return Session{}, err
	}
	current, err := s.sessionByID(ctx, tx, id)
	if err != nil {
		return Session{}, err
	}
	if recent {
		var valid bool
		err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM account_sessions t JOIN passkeys p ON p.credential_id=t.proof_credential AND p.visitor_id=t.visitor_id WHERE t.id=? AND t.proof_at>? AND t.proof_at<=?)", id, s.now().Add(-RecentProofTTL).Unix(), s.now().Unix()).Scan(&valid)
		if err != nil {
			return Session{}, err
		}
		if !valid {
			return Session{}, ErrRecentProof
		}
	}
	return current, nil
}

func (s *Service) BeginReauthentication(ctx context.Context, token, browser string) (Ceremony, error) {
	if browser == "" {
		return Ceremony{}, ErrInvalidProof
	}
	var c Ceremony
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		owner, err := s.ownerSession(ctx, tx, token, false)
		if err != nil {
			return err
		}
		u, _, err := s.user(ctx, tx, owner.Visitor.ID)
		if err != nil {
			return err
		}
		w, err := s.verifier()
		if err != nil {
			return err
		}
		options, data, err := w.BeginLogin(u)
		if err != nil {
			return err
		}
		c = Ceremony{ID: opaque(), ExpiresAt: s.now().Add(CeremonyTTL), Assertion: options}
		return s.storeCeremony(ctx, tx, c, browser, "reauthenticate", u, owner.ID, nil, data)
	})
	return c, err
}

func (s *Service) FinishReauthentication(ctx context.Context, token, id, browser string, response []byte) (Session, error) {
	var result Session
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		owner, err := s.ownerSession(ctx, tx, token, false)
		if err != nil {
			return err
		}
		c, err := s.loadCeremony(ctx, tx, id, browser, "reauthenticate")
		if err != nil {
			return err
		}
		if c.sessionID != owner.ID || c.id != owner.Visitor.ID {
			return ErrInvalidProof
		}
		u, _, err := s.user(ctx, tx, c.id)
		if err != nil {
			return err
		}
		parsed, err := protocol.ParseCredentialRequestResponseBytes(response)
		if err != nil {
			return invalidProof(err)
		}
		w, err := s.verifier()
		if err != nil {
			return err
		}
		credential, err := w.ValidateLogin(u, c.data, parsed)
		if err != nil {
			return invalidProof(err)
		}
		if credential.Authenticator.CloneWarning {
			return ErrInvalidProof
		}
		if err = s.updateCredential(ctx, tx, []byte(c.id), credential); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE account_sessions SET proof_at=?,proof_credential=? WHERE id=?", s.now().Unix(), credential.ID, owner.ID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM account_ceremonies WHERE id=?", id); err != nil {
			return err
		}
		result = owner
		return nil
	})
	return result, err
}

type Passkey struct {
	ID        string
	Label     string
	CreatedAt time.Time
}

func (s *Service) Passkeys(ctx context.Context, token string) ([]Passkey, error) {
	var result []Passkey
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		owner, err := s.ownerSession(ctx, tx, token, false)
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, "SELECT credential_id,label,created_at FROM passkeys WHERE visitor_id=? ORDER BY created_at,credential_id", owner.Visitor.ID)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		result = []Passkey{}
		for rows.Next() {
			var p Passkey
			var raw []byte
			var created int64
			if err := rows.Scan(&raw, &p.Label, &created); err != nil {
				return err
			}
			p.ID = base64.RawURLEncoding.EncodeToString(raw)
			p.CreatedAt = unixTime(created)
			result = append(result, p)
		}
		return rows.Err()
	})
	return result, err
}

func (s *Service) BeginAddPasskey(ctx context.Context, token, browser string) (Ceremony, error) {
	if browser == "" {
		return Ceremony{}, ErrInvalidProof
	}
	var c Ceremony
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		owner, err := s.ownerSession(ctx, tx, token, true)
		if err != nil {
			return err
		}
		u, _, err := s.user(ctx, tx, owner.Visitor.ID)
		if err != nil {
			return err
		}
		w, err := s.verifier()
		if err != nil {
			return err
		}
		exclude := make([]protocol.CredentialDescriptor, len(u.credentials))
		for i, credential := range u.credentials {
			exclude[i] = credential.Descriptor()
		}
		options, data, err := w.BeginRegistration(u, webauthn.WithExclusions(exclude), webauthn.WithExtensions(webauthn.WithExtensionCredProps()))
		if err != nil {
			return err
		}
		c = Ceremony{ID: opaque(), ExpiresAt: s.now().Add(CeremonyTTL), Creation: options}
		return s.storeCeremony(ctx, tx, c, browser, "add", u, owner.ID, nil, data)
	})
	return c, err
}

func (s *Service) FinishAddPasskey(ctx context.Context, token, id, browser string, response []byte, label string) (Passkey, error) {
	var result Passkey
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		owner, err := s.ownerSession(ctx, tx, token, true)
		if err != nil {
			return err
		}
		c, err := s.loadCeremony(ctx, tx, id, browser, "add")
		if err != nil {
			return err
		}
		if c.sessionID != owner.ID || c.id != owner.Visitor.ID {
			return ErrInvalidProof
		}
		u, _, err := s.user(ctx, tx, c.id)
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
		if err = s.insertCredential(ctx, tx, c.id, label, credential); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM account_ceremonies WHERE id=?", id); err != nil {
			return err
		}
		if label == "" {
			label = "Passkey"
		}
		result = Passkey{ID: base64.RawURLEncoding.EncodeToString(credential.ID), Label: label, CreatedAt: s.now().UTC()}
		return nil
	})
	return result, err
}

func (s *Service) RemovePasskey(ctx context.Context, token, credentialID string) error {
	raw, err := base64.RawURLEncoding.DecodeString(credentialID)
	if err != nil {
		return ErrInvalidProof
	}
	return s.db.Write(ctx, func(tx *sql.Tx) error {
		owner, err := s.ownerSession(ctx, tx, token, true)
		if err != nil {
			return err
		}
		var exists bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM passkeys WHERE visitor_id=? AND credential_id=?)", owner.Visitor.ID, raw).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrInvalidProof
		}
		var count int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM passkeys WHERE visitor_id=?", owner.Visitor.ID).Scan(&count); err != nil {
			return err
		}
		if count <= 1 {
			return ErrLastPasskey
		}
		_, err = tx.ExecContext(ctx, "DELETE FROM passkeys WHERE visitor_id=? AND credential_id=?", owner.Visitor.ID, raw)
		return err
	})
}

func (s *Service) RegenerateRecoveryCodes(ctx context.Context, token string) ([]string, error) {
	var codes []string
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		owner, err := s.ownerSession(ctx, tx, token, true)
		if err != nil {
			return err
		}
		codes, err = s.replaceCodes(ctx, tx, owner.Visitor.ID, owner.Generation)
		return err
	})
	if err != nil {
		return nil, err
	}
	return codes, nil
}

func (s *Service) Logout(ctx context.Context, token string) (Effects, error) {
	var effects Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		var id string
		err := tx.QueryRowContext(ctx, "SELECT id FROM account_sessions WHERE token_hash=?", hashToken(token)).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			id = "guest:" + base64.RawURLEncoding.EncodeToString(hashToken(token))
		} else if err != nil {
			return err
		}
		current, err := s.sessionByID(ctx, tx, id)
		if err != nil {
			return err
		}
		effects.RevokedSessions = []Session{current}
		if current.Kind == Guest {
			_, err = tx.ExecContext(ctx, "DELETE FROM visitor_tokens WHERE token_hash=?", hashToken(token))
		} else {
			_, err = tx.ExecContext(ctx, "DELETE FROM account_sessions WHERE id=?", id)
		}
		return err
	})
	if err != nil {
		return Effects{}, err
	}
	return effects, nil
}
