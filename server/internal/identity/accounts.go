package identity

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
)

const (
	// Guest marks a session from before accounts replaced guests. Such
	// sessions no longer resolve; see LegacyGuest.
	Guest               Kind = "guest"
	Account             Kind = "account"
	AccountSessionTTL        = 90 * 24 * time.Hour
	GuestSessionTTL          = 400 * 24 * time.Hour
	OperatorRecoveryTTL      = 30 * time.Minute
)

type Kind string

var (
	ErrInvalidProof = errors.New("invalid or expired proof")
	ErrDisabled     = errors.New("account disabled")
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

// Enrollment is a new session and the token its cookie holds.
type Enrollment struct {
	Session Session
	Token   string
	Effects Effects
}

// RegistrationInput is what registering takes. AccessToken is the browser's
// access pass; GuestToken, when it holds a legacy guest session, stands in for
// the pass and makes the account keep that guest's identity.
type RegistrationInput struct {
	AccessToken string
	GuestToken  string
	Login       string
	Password    string
	Name        string
}

func opaque() string             { return rand.Text() + rand.Text() }
func unixTime(n int64) time.Time { return time.Unix(n, 0).UTC() }

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// Register creates an account with login, password and the name others see,
// and signs this browser in. The access pass, or a legacy guest session, is
// checked before anything else, so a caller without one learns nothing about
// logins or names.
//
// It fails with ErrAccessRequired, ErrInvalidLogin, ErrInvalidPassword, an
// ErrInvalidName, ErrLoginTaken or ErrNameTaken.
func (s *Service) Register(ctx context.Context, in RegistrationInput) (Enrollment, error) {
	if err := s.registrationAllowed(ctx, s.db.Read(), in); err != nil {
		return Enrollment{}, err
	}
	login, err := CleanLogin(in.Login)
	if err != nil {
		return Enrollment{}, err
	}
	name, err := CleanName(in.Name)
	if err != nil {
		return Enrollment{}, err
	}
	if err := checkPasswordRules(in.Password); err != nil {
		return Enrollment{}, err
	}
	hash, err := s.hashPassword(in.Password)
	if err != nil {
		return Enrollment{}, err
	}

	var result Enrollment
	s.reservations.mu.Lock()
	defer s.reservations.mu.Unlock()
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		if err := s.registrationAllowed(ctx, tx, in); err != nil {
			return err
		}
		if err := s.loginFree(ctx, tx, login, ""); err != nil {
			return err
		}
		guest, guestErr := s.legacyGuest(ctx, tx, in.GuestToken)
		id := guest.ID
		if guestErr != nil {
			id = ulid.Make().String()
			if _, err := tx.ExecContext(ctx, "INSERT INTO identities(id,name,created_at) VALUES(?,?,?)", id, name, s.now().UTC().Format(time.RFC3339Nano)); err != nil {
				return err
			}
			if _, err := s.allocateColour(ctx, tx, id); err != nil {
				return err
			}
		}
		if err := s.claimName(ctx, tx, id, name, &result.Effects); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO accounts(identity_id,name_key,created_at,login_key,password_hash) VALUES(?,?,?,?,?)",
			id, NameKey(name), s.now().Unix(), login, hash); err != nil {
			return err
		}
		// The guest's old sessions admit nothing; the new account session replaces them.
		if _, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE identity_id=? AND account_id IS NULL", id); err != nil {
			return err
		}
		var err error
		result.Session, result.Token, err = s.issueSession(ctx, tx, id)
		return err
	})
	if err != nil {
		return Enrollment{}, err
	}
	s.applyNameEffects(result.Effects)
	s.reservations.move(NameKey(result.Session.Visitor.Name), result.Session.Visitor.ID)
	return result, nil
}

func (s *Service) registrationAllowed(ctx context.Context, q queryer, in RegistrationInput) error {
	if _, err := s.legacyGuest(ctx, q, in.GuestToken); err == nil {
		return nil
	} else if !errors.Is(err, ErrNoVisitor) {
		return err
	}
	passed, err := s.accessPassed(ctx, q, in.AccessToken)
	if err != nil {
		return err
	}
	if !passed {
		return ErrAccessRequired
	}
	return nil
}

// loginFree fails with ErrLoginTaken when an account other than exceptID has
// login.
func (s *Service) loginFree(ctx context.Context, q queryer, login, exceptID string) error {
	var taken bool
	if err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM accounts WHERE login_key=? AND identity_id<>?)", login, exceptID).Scan(&taken); err != nil {
		return err
	}
	if taken {
		return ErrLoginTaken
	}
	return nil
}

// Login signs this browser in to the account with login and password. It
// fails with ErrAccessRequired without a current access pass, and with
// ErrWrongCredentials for an unknown login or a wrong password alike. Only
// once the password is right does it fail with ErrDisabled.
func (s *Service) Login(ctx context.Context, accessToken, login, password string) (Enrollment, error) {
	passed, err := s.AccessPassed(ctx, accessToken)
	if err != nil {
		return Enrollment{}, err
	}
	if !passed {
		return Enrollment{}, ErrAccessRequired
	}
	var id string
	var hash sql.NullString
	var disabled bool
	err = s.db.Read().QueryRowContext(ctx, "SELECT identity_id,password_hash,disabled FROM accounts WHERE login_key=?",
		strings.ToLower(strings.TrimSpace(login))).Scan(&id, &hash, &disabled)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Enrollment{}, err
	}
	if !s.passwordMatches(hash.String, password) {
		return Enrollment{}, ErrWrongCredentials
	}
	if disabled {
		return Enrollment{}, ErrDisabled
	}
	var result Enrollment
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		var err error
		result.Session, result.Token, err = s.issueSession(ctx, tx, id)
		return err
	})
	if err != nil {
		return Enrollment{}, err
	}
	return result, nil
}

// issueSession starts a session of the enabled account id at its current
// security generation.
func (s *Service) issueSession(ctx context.Context, tx *sql.Tx, id string) (Session, string, error) {
	var generation int64
	err := tx.QueryRowContext(ctx, "SELECT generation FROM accounts WHERE identity_id=? AND disabled=0", id).Scan(&generation)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, "", ErrNoVisitor
	}
	if err != nil {
		return Session{}, "", err
	}
	now := s.now().Unix()
	token, sessionID := opaque(), opaque()
	_, err = tx.ExecContext(ctx, `INSERT INTO sessions(id,token_hash,identity_id,account_id,generation,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?)`, sessionID, hashToken(token), id, id, generation, now, now+int64(AccountSessionTTL/time.Second))
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

// currentSessions selects the sessions that admit someone: unexpired sessions
// of enabled accounts at their current security generation.
const currentSessions = `FROM sessions t
    JOIN accounts a ON a.identity_id=t.account_id
    WHERE t.expires_at>? AND a.disabled=0 AND a.generation=t.generation`

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

// GuestSession recovered a guest's session for voice transports. Guests no
// longer exist, so it always fails with ErrNoVisitor; voice keeps calling it
// for grants issued before they were removed.
func (s *Service) GuestSession(context.Context, string) (Session, error) {
	return Session{}, ErrNoVisitor
}

func (s *Service) sessionByID(ctx context.Context, q queryer, id string) (Session, error) {
	var result Session
	var identityID string
	var expires int64
	result.ID = id
	result.Kind = Account
	err := q.QueryRowContext(ctx, "SELECT t.identity_id,t.generation,t.expires_at "+currentSessions+" AND t.id=?", s.now().Unix(), id).Scan(&identityID, &result.Generation, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNoVisitor
	}
	if err != nil {
		return Session{}, err
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
	// Former guests keep their messages under their old name; their identity
	// takes another so the account can have it.
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

// accountRef finds the account named by ref, a login or an account ID, and
// returns its ID, or fails with ErrNoVisitor.
func (s *Service) accountRef(ctx context.Context, q queryer, ref string) (string, error) {
	var id string
	// An ID wins: anyone may register a login that spells another account's ID.
	err := q.QueryRowContext(ctx, "SELECT identity_id FROM accounts WHERE login_key=? OR identity_id=? ORDER BY identity_id=? DESC LIMIT 1",
		strings.ToLower(strings.TrimSpace(ref)), ref, ref).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNoVisitor
	}
	if err != nil {
		return "", fmt.Errorf("find account: %w", err)
	}
	return id, nil
}
