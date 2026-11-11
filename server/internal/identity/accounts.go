package identity

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/oklog/ulid/v2"
)

const (
	Guest               Kind = "guest"
	Account             Kind = "account"
	AccountSessionTTL        = 90 * 24 * time.Hour
	GuestSessionTTL          = 400 * 24 * time.Hour
	CeremonyTTL              = 5 * time.Minute
	RecentProofTTL           = 5 * time.Minute
	InvitationTTL            = 7 * 24 * time.Hour
	OperatorRecoveryTTL      = 30 * time.Minute
)

type Kind string

var (
	ErrInvalidProof     = errors.New("invalid or expired proof")
	ErrRecentProof      = errors.New("recent passkey verification required")
	ErrLastPasskey      = errors.New("cannot remove last passkey")
	ErrCredentialExists = errors.New("credential already registered")
	ErrDisabled         = errors.New("account disabled")
)

// Session is an authorization snapshot. ValidateSession must be called again
// at live/voice admission; retaining this value alone does not grant access.
type Session struct {
	Visitor    Visitor
	ID         string
	Kind       Kind
	Generation int64
	ExpiresAt  time.Time
}

// Effects are committed changes that the caller must enforce before reporting
// success. Displaced visitors need retryable refresh, never access.revoked.
type Effects struct {
	RevokedSessions    []Session
	RevokedIdentity    string
	SecurityGeneration int64
	AccountDisabled    bool
	GuestGeneration    int64
	Displaced          []Visitor
}

type Enrollment struct {
	Session       Session
	Token         string
	RecoveryCodes []string
	Effects       Effects
}

type Invitation struct {
	ID        string
	Token     string
	Link      string
	CreatedAt time.Time
	ExpiresAt time.Time
	Redeemed  bool
	Revoked   bool
}

type RegistrationInput struct {
	Invitation     string
	GuestToken     string
	Name           string
	BrowserContext string
}

type Ceremony struct {
	ID        string
	ExpiresAt time.Time
	Creation  *protocol.CredentialCreation
	Assertion *protocol.CredentialAssertion
}

type accountUser struct {
	id, name    string
	credentials []webauthn.Credential
}

func (u accountUser) WebAuthnID() []byte                         { return []byte(u.id) }
func (u accountUser) WebAuthnName() string                       { return u.name }
func (u accountUser) WebAuthnDisplayName() string                { return u.name }
func (u accountUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

func (s *Service) verifier() (*webauthn.WebAuthn, error) {
	u, err := url.Parse(s.origin)
	if err != nil {
		return nil, err
	}
	return webauthn.New(&webauthn.Config{RPID: u.Hostname(), RPDisplayName: "Falky", RPOrigins: []string{s.origin}, AuthenticatorSelection: protocol.AuthenticatorSelection{ResidentKey: protocol.ResidentKeyRequirementRequired, RequireResidentKey: ptr(true), UserVerification: protocol.VerificationRequired}})
}
func ptr[T any](v T) *T          { return &v }
func opaque() string             { return rand.Text() + rand.Text() }
func unixTime(n int64) time.Time { return time.Unix(n, 0).UTC() }

func (s *Service) CreateInvitation(ctx context.Context) (Invitation, error) {
	i := Invitation{ID: ulid.Make().String(), Token: opaque(), CreatedAt: s.now().UTC(), ExpiresAt: s.now().Add(InvitationTTL).UTC()}
	i.Link = s.origin + "/#invite=" + i.Token
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO account_invitations(id,token_hash,created_at,expires_at) VALUES(?,?,?,?)", i.ID, hashToken(i.Token), i.CreatedAt.Unix(), i.ExpiresAt.Unix())
		return err
	})
	return i, err
}

func (s *Service) Invitations(ctx context.Context) ([]Invitation, error) {
	rows, err := s.db.Read().QueryContext(ctx, "SELECT id,created_at,expires_at,redeemed_at IS NOT NULL,revoked_at IS NOT NULL FROM account_invitations ORDER BY created_at,id")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := []Invitation{}
	for rows.Next() {
		var i Invitation
		var created, expires int64
		if err := rows.Scan(&i.ID, &created, &expires, &i.Redeemed, &i.Revoked); err != nil {
			return nil, err
		}
		i.CreatedAt = unixTime(created)
		i.ExpiresAt = unixTime(expires)
		result = append(result, i)
	}
	return result, rows.Err()
}

func (s *Service) RevokeInvitation(ctx context.Context, id string) error {
	return s.db.Write(ctx, func(tx *sql.Tx) error {
		r, err := tx.ExecContext(ctx, "UPDATE account_invitations SET revoked_at=? WHERE id=? AND redeemed_at IS NULL AND revoked_at IS NULL", s.now().Unix(), id)
		return affected(r, err, ErrInvalidProof)
	})
}

func affected(r sql.Result, err error, missing error) error {
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err == nil && n == 0 {
		return missing
	}
	return err
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (s *Service) invitation(ctx context.Context, q queryer, hash []byte) error {
	var id string
	err := q.QueryRowContext(ctx, "SELECT id FROM account_invitations WHERE token_hash=? AND expires_at>? AND redeemed_at IS NULL AND revoked_at IS NULL", hash, s.now().Unix()).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrInvalidProof
	}
	return err
}

func (s *Service) BeginRegistration(ctx context.Context, in RegistrationInput) (Ceremony, error) {
	if in.BrowserContext == "" {
		return Ceremony{}, ErrInvalidProof
	}
	if err := s.invitation(ctx, s.db.Read(), hashToken(in.Invitation)); err != nil {
		return Ceremony{}, err
	}
	name, err := CleanName(in.Name)
	if err != nil {
		return Ceremony{}, err
	}
	u := accountUser{id: ulid.Make().String(), name: name}
	guestID := ""
	if in.GuestToken != "" {
		session, err := s.ResolveSession(ctx, in.GuestToken)
		if err != nil {
			return Ceremony{}, err
		}
		if session.Kind != Guest {
			return Ceremony{}, ErrInvalidProof
		}
		u.id = session.Visitor.ID
		guestID = session.ID
	}
	w, err := s.verifier()
	if err != nil {
		return Ceremony{}, err
	}
	options, data, err := w.BeginRegistration(u, webauthn.WithExtensions(webauthn.WithExtensionCredProps()))
	if err != nil {
		return Ceremony{}, err
	}
	c := Ceremony{ID: opaque(), ExpiresAt: s.now().Add(CeremonyTTL), Creation: options}
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		return s.storeCeremony(ctx, tx, c, in.BrowserContext, "register", u, guestID, hashToken(in.Invitation), data)
	})
	return c, err
}

func (s *Service) storeCeremony(ctx context.Context, tx *sql.Tx, c Ceremony, browser, purpose string, u accountUser, sessionID string, proof []byte, data *webauthn.SessionData) error {
	body, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO account_ceremonies(id,context_hash,purpose,identity_id,session_id,name,proof_hash,session_data,expires_at) VALUES(?,?,?,?,?,?,?,?,?)", c.ID, hashToken(browser), purpose, u.id, sessionID, u.name, proof, string(body), c.ExpiresAt.Unix())
	return err
}

type ceremonyState struct {
	id, sessionID, name string
	proof               []byte
	data                webauthn.SessionData
}

func (s *Service) loadCeremony(ctx context.Context, tx *sql.Tx, id, browser, purpose string) (ceremonyState, error) {
	var c ceremonyState
	var body string
	if browser == "" {
		return c, ErrInvalidProof
	}
	err := tx.QueryRowContext(ctx, "SELECT identity_id,session_id,name,proof_hash,session_data FROM account_ceremonies WHERE id=? AND context_hash=? AND purpose=? AND expires_at>?", id, hashToken(browser), purpose, s.now().Unix()).Scan(&c.id, &c.sessionID, &c.name, &c.proof, &body)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrInvalidProof
	}
	if err != nil {
		return c, err
	}
	err = json.Unmarshal([]byte(body), &c.data)
	return c, err
}

func (s *Service) FinishRegistration(ctx context.Context, id, browser string, response []byte, label string) (Enrollment, error) {
	var result Enrollment
	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		c, err := s.loadCeremony(ctx, tx, id, browser, "register")
		if err != nil {
			return err
		}
		if err = s.invitation(ctx, tx, c.proof); err != nil {
			return err
		}
		if c.sessionID != "" {
			guest, err := s.sessionByID(ctx, tx, c.sessionID)
			if err != nil || guest.Kind != Guest || guest.Visitor.ID != c.id {
				return ErrNoVisitor
			}
			result.Effects.RevokedSessions = append(result.Effects.RevokedSessions, guest)
		}
		u := accountUser{id: c.id, name: c.name}
		credential, err := s.verifyCreation(u, c.data, response)
		if err != nil {
			return err
		}
		if err = s.availableCredential(ctx, tx, credential.ID); err != nil {
			return err
		}
		if c.sessionID == "" {
			if _, err = tx.ExecContext(ctx, "INSERT INTO identities(id,name,created_at) VALUES(?,?,?)", c.id, c.name, s.now().UTC().Format(time.RFC3339Nano)); err != nil {
				return err
			}
			if _, err = s.allocateColour(ctx, tx, c.id); err != nil {
				return err
			}
		}
		if err = s.claimName(ctx, tx, c.id, c.name, &result.Effects); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO accounts(identity_id,name_key,created_at) VALUES(?,?,?)", c.id, NameKey(c.name), s.now().Unix()); err != nil {
			return err
		}
		if err = s.insertCredential(ctx, tx, c.id, label, credential); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE identity_id=? AND account_id IS NULL", c.id); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE account_invitations SET redeemed_at=? WHERE token_hash=?", s.now().Unix(), c.proof); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM account_ceremonies WHERE id=?", id); err != nil {
			return err
		}
		result.RecoveryCodes, err = s.replaceCodes(ctx, tx, c.id, 1)
		if err != nil {
			return err
		}
		result.Session, result.Token, err = s.issueSession(ctx, tx, c.id, Account, credential.ID)
		return err
	})
	if err != nil {
		return Enrollment{}, err
	}
	s.applyNameEffects(result.Effects)
	s.reservations.move(NameKey(result.Session.Visitor.Name), result.Session.Visitor.ID)
	return result, nil
}

func (s *Service) verifyCreation(u accountUser, data webauthn.SessionData, response []byte) (*webauthn.Credential, error) {
	parsed, err := protocol.ParseCredentialCreationResponseBytes(response)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidProof, err)
	}
	w, err := s.verifier()
	if err != nil {
		return nil, err
	}
	credential, err := w.CreateCredential(u, data, parsed)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidProof, err)
	}
	// Discoverability is required in the creation options; credProps is optional
	// and Safari omits it. Only an explicit negative result contradicts the request.
	if credential.Extensions.RK != nil && !*credential.Extensions.RK {
		return nil, ErrInvalidProof
	}
	return credential, nil
}

func (s *Service) availableCredential(ctx context.Context, tx *sql.Tx, id []byte) error {
	var n int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM passkeys WHERE credential_id=?", id).Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return ErrCredentialExists
	}
	return nil
}

func (s *Service) insertCredential(ctx context.Context, tx *sql.Tx, id, label string, c *webauthn.Credential) error {
	if label == "" {
		label = "Passkey"
	}
	if len(label) > 128 {
		return ErrInvalidName
	}
	body, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO passkeys(credential_id,identity_id,label,credential,created_at) VALUES(?,?,?,?,?)", c.ID, id, label, string(body), s.now().Unix())
	return err
}

func (s *Service) replaceCodes(ctx context.Context, tx *sql.Tx, id string, generation int64) ([]string, error) {
	if _, err := tx.ExecContext(ctx, "DELETE FROM account_recovery_proofs WHERE identity_id=? AND kind='code'", id); err != nil {
		return nil, err
	}
	phrase, err := newRecoveryPhrase()
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO account_recovery_proofs(token_hash,identity_id,kind,generation) VALUES(?,?,'code',?)", hashToken(phrase), id, generation); err != nil {
		return nil, err
	}
	codes := []string{phrase}
	return codes, nil
}

func (s *Service) issueSession(ctx context.Context, tx *sql.Tx, id string, kind Kind, credential []byte) (Session, string, error) {
	var accountID, proofAt, proofCredential any
	var generation int64
	var err error
	ttl := GuestSessionTTL
	now := s.now().Unix()
	switch kind {
	case Guest:
		err = tx.QueryRowContext(ctx, "SELECT generation FROM access WHERE id=1").Scan(&generation)
	case Account:
		err = tx.QueryRowContext(ctx, "SELECT generation FROM accounts WHERE identity_id=? AND disabled=0", id).Scan(&generation)
		accountID, proofAt, proofCredential = id, now, credential
		ttl = AccountSessionTTL
	default:
		return Session{}, "", ErrNoVisitor
	}
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, "", ErrNoVisitor
	}
	if err != nil {
		return Session{}, "", err
	}
	token, sessionID := opaque(), opaque()
	_, err = tx.ExecContext(ctx, `INSERT INTO sessions(id,token_hash,identity_id,account_id,generation,created_at,expires_at,proof_at,proof_credential)
        VALUES(?,?,?,?,?,?,?,?,?)`, sessionID, hashToken(token), id, accountID, generation, now, now+int64(ttl/time.Second), proofAt, proofCredential)
	if err != nil {
		return Session{}, "", err
	}
	session, err := s.sessionByID(ctx, tx, sessionID)
	return session, token, err
}

func (s *Service) visitorRecord(ctx context.Context, q queryer, id string) (Visitor, error) {
	var v Visitor
	err := q.QueryRowContext(ctx, "SELECT v.id,v.name,c.palette,c.revision FROM identities v JOIN profiles c ON c.identity_id=v.id WHERE v.id=?", id).Scan(&v.ID, &v.Name, &v.Colour.Palette, &v.Colour.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNoVisitor
	}
	v.Colour.VisitorID = v.ID
	return v, err
}

const currentSessions = `FROM sessions t
    LEFT JOIN accounts a ON a.identity_id=t.account_id
    LEFT JOIN access g ON g.id=1
    WHERE t.expires_at>? AND (
        (t.account_id IS NOT NULL AND a.disabled=0 AND a.generation=t.generation)
        OR (t.account_id IS NULL AND g.generation=t.generation
            AND NOT EXISTS(SELECT 1 FROM accounts x WHERE x.identity_id=t.identity_id)))`

func (s *Service) ResolveSession(ctx context.Context, token string) (Session, error) {
	if token == "" {
		return Session{}, ErrNoVisitor
	}
	var id string
	err := s.db.Read().QueryRowContext(ctx, "SELECT id FROM sessions WHERE token_hash=?", hashToken(token)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNoVisitor
	}
	if err != nil {
		return Session{}, err
	}
	return s.sessionByID(ctx, s.db.Read(), id)
}

// GuestSession recovers the unique current guest session for an already
// authenticated transport identity. It never substitutes for cookie or JWT
// authentication; ambiguous persisted authorization fails closed.
func (s *Service) GuestSession(ctx context.Context, identityID string) (Session, error) {
	rows, err := s.db.Read().QueryContext(ctx, "SELECT t.id "+currentSessions+" AND t.identity_id=? AND t.account_id IS NULL LIMIT 2", s.now().Unix(), identityID)
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return Session{}, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return Session{}, err
	}
	if len(ids) != 1 {
		return Session{}, ErrNoVisitor
	}
	return s.sessionByID(ctx, s.db.Read(), ids[0])
}

func (s *Service) sessionByID(ctx context.Context, q queryer, id string) (Session, error) {
	var result Session
	var identityID string
	var accountID sql.NullString
	var expires int64
	result.ID = id
	err := q.QueryRowContext(ctx, "SELECT t.identity_id,t.account_id,t.generation,t.expires_at "+currentSessions+" AND t.id=?", s.now().Unix(), id).Scan(&identityID, &accountID, &result.Generation, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNoVisitor
	}
	if err != nil {
		return Session{}, err
	}
	result.Kind = Guest
	if accountID.Valid {
		result.Kind = Account
	}
	result.ExpiresAt = unixTime(expires)
	result.Visitor, err = s.visitorRecord(ctx, q, identityID)
	return result, err
}

// ValidateSession rechecks current state using the immutable session binding.
// Callers must serialize admission with their own postcommit effect handling.
func (s *Service) ValidateSession(ctx context.Context, session Session) (Session, error) {
	current, err := s.sessionByID(ctx, s.db.Read(), session.ID)
	if err != nil {
		return Session{}, err
	}
	if current.Kind != session.Kind || current.Visitor.ID != session.Visitor.ID || current.Generation != session.Generation {
		return Session{}, ErrNoVisitor
	}
	return current, nil
}

func (s *Service) claimName(ctx context.Context, tx *sql.Tx, id, name string, effects *Effects) error {
	var owner string
	err := tx.QueryRowContext(ctx, "SELECT identity_id FROM accounts WHERE name_key=? AND identity_id<>?", NameKey(name), id).Scan(&owner)
	if err == nil {
		return ErrNameTaken
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	rows, err := tx.QueryContext(ctx, "SELECT v.id,v.name,EXISTS(SELECT 1 FROM accounts a WHERE a.identity_id=v.id) FROM identities v")
	if err != nil {
		return err
	}
	var displaced []string
	used := map[string]bool{NameKey(name): true}
	for rows.Next() {
		var guestID, guestName string
		var account bool
		if err := rows.Scan(&guestID, &guestName, &account); err != nil {
			_ = rows.Close()
			return err
		}
		used[NameKey(guestName)] = true
		if guestID != id && !account && NameKey(guestName) == NameKey(name) {
			displaced = append(displaced, guestID)
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	for _, guestID := range displaced {
		fallback := "Guest " + rand.Text()[:12]
		for used[NameKey(fallback)] || s.reservations.takenBy(NameKey(fallback), guestID, s.now()) {
			fallback = "Guest " + rand.Text()[:12]
		}
		used[NameKey(fallback)] = true
		if _, err = tx.ExecContext(ctx, "UPDATE identities SET name=? WHERE id=?", fallback, guestID); err != nil {
			return err
		}
		v, err := s.visitorRecord(ctx, tx, guestID)
		if err != nil {
			return err
		}
		effects.Displaced = append(effects.Displaced, v)
	}
	_, err = tx.ExecContext(ctx, "UPDATE identities SET name=? WHERE id=?", name, id)
	return err
}

func (s *Service) applyNameEffects(e Effects) {
	for _, v := range e.Displaced {
		s.reservations.move(NameKey(v.Name), v.ID)
	}
}

func (s *Service) reservedName(ctx context.Context, q queryer, key, id string) error {
	var owner string
	err := q.QueryRowContext(ctx, "SELECT identity_id FROM accounts WHERE name_key=? AND identity_id<>?", key, id).Scan(&owner)
	if err == nil {
		return ErrNameTaken
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	return err
}
