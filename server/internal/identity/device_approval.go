package identity

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/netip"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	SignInTTL                 = 5 * time.Minute
	SignInResendCooldown      = 10 * time.Second
	signInPendingLimit        = 3
	signInCodeAttemptLimit    = 5
	signInCodeDigits          = 4
	signInCodeSpace           = 10000
	signInBrowserSecretLength = 52
	signInUserAgentLimit      = 256
)

var (
	ErrAccountSwitchRequired = errors.New("account_switch_required")
	ErrAlreadySignedIn       = errors.New("already_signed_in")
	ErrSignInPendingCap      = errors.New("pending_request_cap")
	ErrSignInConflict        = errors.New("signin_conflict")
)

type SignInCooldownError struct{ RetryAfter time.Duration }

func (e *SignInCooldownError) Error() string { return "rate_limited" }

// SignInRequestView contains only display and ordering data, safe for private hints.
type SignInRequestView struct {
	ID                 string
	Type               string
	State              string
	LinkID             string
	Version            int64
	RequesterUserAgent string
	RequesterIP        string
	CreatedAt          time.Time
	ExpiresAt          time.Time
	ApprovedAt         *time.Time
	ConsumedAt         *time.Time
}
type SignInLinkView struct {
	ID                        string
	State                     string
	Version                   int64
	CreatedAt                 time.Time
	ExpiresAt                 time.Time
	ApprovalGrantsRecentProof bool
	Requests                  []SignInRequestView
}

// IssuerSessionID is routing metadata, never a payload for the candidate.
type SignInChange struct {
	IssuerSessionID string
	NotifyIssuer    bool
	Request         SignInRequestView
}
type SignInLinkResult struct {
	Link  SignInLinkView
	Token string
	URL   string
}
type SignInBeginResult struct {
	Request       SignInRequestView
	BrowserSecret string
	Code          string
	QRToken       string
	URL           string
}
type SignInPreview struct {
	Request                   SignInRequestView
	ApprovalGrantsRecentProof bool
}
type SignInFinish struct {
	Session Session
	Token   string
	Effects Effects
}

// SignInAllocation runs under the identity write transaction only for allocation.
// It must not call identity or perform network I/O. An error preserves the old flow.
type SignInAllocation func(browserHash string) error

type signInLink struct {
	SignInLinkView
	accountID, issuer string
	hash              []byte
	failures          int
	notified          sql.NullInt64
}
type signInRequest struct {
	SignInRequestView
	browser, qrHash, origin, ciphertext []byte
	code, approver, resultID            string
	recent                              bool
}

const (
	signInLinkColumns    = `id,state,version,created_at,expires_at,identity_id,COALESCE(issuer_session_id,''),token_hash,failed_code_attempts,last_notified_at`
	signInRequestColumns = `id,type,state,COALESCE(link_id,''),version,requester_user_agent,requester_ip,created_at,expires_at,approved_at,consumed_at,browser_token_hash,qr_token_hash,origin_passkey_credential_id,delivery_ciphertext,COALESCE(code,''),COALESCE(approved_by_session_id,''),COALESCE(created_session_id,''),approver_recent_proof`
)

func readSignInLink(ctx context.Context, q queryer, where string, args ...any) (signInLink, error) {
	return scanSignInLink(q.QueryRowContext(ctx, "SELECT "+signInLinkColumns+" FROM account_signin_links WHERE "+where, args...))
}

func signInLinks(ctx context.Context, q queryer, where string, args ...any) ([]signInLink, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+signInLinkColumns+" FROM account_signin_links WHERE "+where+" ORDER BY created_at,id", args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var links []signInLink
	for rows.Next() {
		link, err := scanSignInLink(rows)
		if err != nil {
			return nil, err
		}
		links = append(links, link)
	}
	return links, rows.Err()
}

func scanSignInLink(row interface{ Scan(...any) error }) (signInLink, error) {
	var l signInLink
	var created, expires int64
	err := row.Scan(&l.ID, &l.State, &l.Version, &created, &expires, &l.accountID, &l.issuer, &l.hash, &l.failures, &l.notified)
	l.CreatedAt, l.ExpiresAt = unixTime(created), unixTime(expires)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrInvalidProof
	}
	return l, err
}

func scanSignInRequest(row interface{ Scan(...any) error }) (signInRequest, error) {
	var r signInRequest
	var created, expires int64
	var approved, consumed sql.NullInt64
	err := row.Scan(&r.ID, &r.Type, &r.State, &r.LinkID, &r.Version, &r.RequesterUserAgent, &r.RequesterIP, &created, &expires, &approved, &consumed, &r.browser, &r.qrHash, &r.origin, &r.ciphertext, &r.code, &r.approver, &r.resultID, &r.recent)
	r.CreatedAt, r.ExpiresAt = unixTime(created), unixTime(expires)
	if approved.Valid {
		r.ApprovedAt = ptr(unixTime(approved.Int64))
	}
	if consumed.Valid {
		r.ConsumedAt = ptr(unixTime(consumed.Int64))
	}
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrInvalidProof
	}
	return r, err
}

func readSignInRequest(ctx context.Context, q queryer, where string, args ...any) (signInRequest, error) {
	return scanSignInRequest(q.QueryRowContext(ctx, "SELECT "+signInRequestColumns+" FROM account_signin_requests WHERE "+where, args...))
}

func signInRequests(ctx context.Context, q queryer, where string, args ...any) ([]signInRequest, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+signInRequestColumns+" FROM account_signin_requests WHERE "+where+" ORDER BY created_at,id", args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := []signInRequest{}
	for rows.Next() {
		r, err := scanSignInRequest(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

func (s *Service) currentToken(ctx context.Context, tx *sql.Tx, token string) (Session, error) {
	if token == "" {
		return Session{}, ErrNoVisitor
	}
	var id string
	if err := tx.QueryRowContext(ctx, "SELECT id FROM sessions WHERE token_hash=?", hashToken(token)).Scan(&id); errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNoVisitor
	} else if err != nil {
		return Session{}, err
	}
	return s.sessionByID(ctx, tx, id)
}

func (s *Service) signInAccountConflict(ctx context.Context, tx *sql.Tx, token, accountID, exact string) error {
	current, err := s.currentToken(ctx, tx, token)
	if errors.Is(err, ErrNoVisitor) {
		return nil
	}
	if err != nil {
		return err
	}
	if exact != "" && current.ID == exact {
		return nil
	}
	if current.Kind != Account {
		if exact != "" {
			return ErrSignInConflict
		}
		return nil
	}
	if current.Visitor.ID != accountID && accountID != "" {
		return ErrAccountSwitchRequired
	}
	return ErrAlreadySignedIn
}

func (s *Service) liveSignInLink(ctx context.Context, tx *sql.Tx, l signInLink) error {
	if !s.now().Before(l.ExpiresAt) || l.State == "revoked" {
		return ErrInvalidProof
	}
	if l.State == "consumed" {
		return nil
	}
	issuer, err := s.sessionByID(ctx, tx, l.issuer)
	if errors.Is(err, ErrNoVisitor) {
		return ErrInvalidProof
	}
	if err != nil {
		return err
	}
	if issuer.Kind != Account || issuer.Visitor.ID != l.accountID {
		return ErrInvalidProof
	}
	return nil
}

func (s *Service) issuerLink(ctx context.Context, tx *sql.Tx, token, id string) (signInLink, Session, error) {
	issuer, err := s.ownerSession(ctx, tx, token, false)
	if err != nil {
		return signInLink{}, Session{}, err
	}
	l, err := readSignInLink(ctx, tx, "id=?", id)
	if err != nil {
		return l, issuer, err
	}
	if l.issuer != issuer.ID || l.accountID != issuer.Visitor.ID {
		return l, issuer, ErrInvalidProof
	}
	if !s.now().Before(l.ExpiresAt) {
		return l, issuer, ErrInvalidProof
	}
	return l, issuer, nil
}

func (s *Service) linkView(ctx context.Context, tx *sql.Tx, l signInLink) (SignInLinkView, error) {
	view := l.SignInLinkView
	view.Requests = []SignInRequestView{}
	requests, err := signInRequests(ctx, tx, "link_id=?", l.ID)
	if err != nil {
		return view, err
	}
	for _, r := range requests {
		view.Requests = append(view.Requests, r.SignInRequestView)
	}
	if l.issuer != "" {
		_, err := s.sessionByID(ctx, tx, l.issuer)
		if err != nil {
			return view, err
		}
	}
	return view, nil
}

func (s *Service) requestChange(ctx context.Context, tx *sql.Tx, id string, notify bool) (SignInChange, error) {
	r, err := readSignInRequest(ctx, tx, "id=?", id)
	if err != nil {
		return SignInChange{}, err
	}
	c := SignInChange{Request: r.SignInRequestView, NotifyIssuer: notify && r.Type == "link"}
	if r.LinkID != "" {
		l, err := readSignInLink(ctx, tx, "id=?", r.LinkID)
		if err != nil {
			return c, err
		}
		c.IssuerSessionID = l.issuer
	}
	return c, nil
}

func (s *Service) appendRequestChange(ctx context.Context, tx *sql.Tx, e *Effects, id string, notify bool) error {
	c, err := s.requestChange(ctx, tx, id, notify)
	if err == nil {
		e.SignInChanges = append(e.SignInChanges, c)
	}
	return err
}

func (s *Service) cancelRequest(ctx context.Context, tx *sql.Tx, effects *Effects, id string, notify bool) error {
	result, err := tx.ExecContext(ctx, "UPDATE account_signin_requests SET state='cancelled',version=version+1 WHERE id=? AND state IN ('pending','approved')", id)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil || changed == 0 {
		return err
	}
	return s.appendRequestChange(ctx, tx, effects, id, notify)
}

func (s *Service) cancelLinks(ctx context.Context, tx *sql.Tx, effects *Effects, where string, args ...any) error {
	links, err := signInLinks(ctx, tx, where, args...)
	if err != nil {
		return err
	}
	for _, link := range links {
		if err := s.cancelLink(ctx, tx, link, effects); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) cancelLink(ctx context.Context, tx *sql.Tx, l signInLink, e *Effects) error {
	if l.State == "consumed" || l.State == "revoked" {
		return nil
	}
	rs, err := signInRequests(ctx, tx, "link_id=? AND state IN ('pending','approved')", l.ID)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE account_signin_links SET state='revoked',revoked_at=?,version=version+1 WHERE id=?", s.now().Unix(), l.ID); err != nil {
		return err
	}
	for _, r := range rs {
		if err = s.cancelRequest(ctx, tx, e, r.ID, true); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) CreateSignInLink(ctx context.Context, token string) (SignInLinkResult, Effects, error) {
	var result SignInLinkResult
	var e Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		issuer, err := s.ownerSession(ctx, tx, token, false)
		if err != nil {
			return err
		}
		if err = s.cancelLinks(ctx, tx, &e, "issuer_session_id=? AND state IN ('open','approved')", issuer.ID); err != nil {
			return err
		}
		id, secret, now := opaque(), opaque(), s.now().Unix()
		if _, err = tx.ExecContext(ctx, "INSERT INTO account_signin_links(id,identity_id,issuer_session_id,token_hash,state,created_at,expires_at) VALUES(?,?,?,?,'open',?,?)", id, issuer.Visitor.ID, issuer.ID, hashToken(secret), now, now+int64(SignInTTL/time.Second)); err != nil {
			return err
		}
		l, err := readSignInLink(ctx, tx, "id=?", id)
		if err != nil {
			return err
		}
		result.Link, err = s.linkView(ctx, tx, l)
		result.Token = secret
		result.URL = s.origin + "/#signin=" + secret
		return err
	})
	if err != nil {
		return SignInLinkResult{}, Effects{}, err
	}
	return result, e, nil
}

// A read transaction gives multi-query views one snapshot without queuing behind
// the serialized writer. Stream registration still holds the lifecycle gate.
func (s *Service) readSignInState(ctx context.Context, read func(*sql.Tx) error) error {
	tx, err := s.db.Read().BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	return read(tx)
}

func (s *Service) SignInLink(ctx context.Context, token, id string) (SignInLinkView, error) {
	var result SignInLinkView
	err := s.readSignInState(ctx, func(tx *sql.Tx) error {
		l, _, err := s.issuerLink(ctx, tx, token, id)
		if err != nil {
			return err
		}
		result, err = s.linkView(ctx, tx, l)
		return err
	})
	return result, err
}

// SignInLinks supplies exact-session reconnect state without recovering bearer tokens.
func (s *Service) SignInLinks(ctx context.Context, token string) ([]SignInLinkView, error) {
	result := []SignInLinkView{}
	err := s.readSignInState(ctx, func(tx *sql.Tx) error {
		issuer, err := s.ownerSession(ctx, tx, token, false)
		if err != nil {
			return err
		}
		links, err := signInLinks(ctx, tx, "issuer_session_id=? AND expires_at>?", issuer.ID, s.now().Unix())
		if err != nil {
			return err
		}
		for _, l := range links {
			v, err := s.linkView(ctx, tx, l)
			if err != nil {
				return err
			}
			result = append(result, v)
		}
		return nil
	})
	return result, err
}

func (s *Service) RevokeSignInLink(ctx context.Context, token, id string) (Effects, error) {
	var e Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		l, _, err := s.issuerLink(ctx, tx, token, id)
		if err != nil {
			return err
		}
		if l.State == "consumed" {
			return ErrSignInConflict
		}
		return s.cancelLink(ctx, tx, l, &e)
	})
	if err != nil {
		return Effects{}, err
	}
	return e, nil
}

func signInBrowser(browser string) (string, error) {
	if browser == "" {
		return opaque(), nil
	}
	if len(browser) != signInBrowserSecretLength {
		return "", ErrInvalidProof
	}
	return browser, nil
}

func signInIP(values []string) string {
	if len(values) == 0 {
		return ""
	}
	addr, err := netip.ParseAddr(values[0])
	if err != nil {
		return ""
	}
	return addr.Unmap().WithZone("").String()
}

func signInUA(ua string) string {
	ua = strings.ToValidUTF8(ua, "")
	if utf8.RuneCountInString(ua) > signInUserAgentLimit {
		ua = string([]rune(ua)[:signInUserAgentLimit])
	}
	return ua
}

func (s *Service) newSignInCode(ctx context.Context, tx *sql.Tx, linkID string) (string, error) {
	for {
		code, err := s.signInCode()
		if err != nil {
			return "", err
		}
		if len(code) != signInCodeDigits || strings.Trim(code, "0123456789") != "" {
			return "", ErrInvalidProof
		}
		var exists bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM account_signin_requests WHERE link_id=? AND code=?)", linkID, code).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return code, nil
		}
	}
}

func (s *Service) BeginSignInRequest(ctx context.Context, linkToken, browser, currentToken, ua string, requesterIP ...string) (SignInBeginResult, Effects, error) {
	var result SignInBeginResult
	var e Effects
	browser, err := signInBrowser(browser)
	if err != nil {
		return result, e, err
	}
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		l, err := readSignInLink(ctx, tx, "token_hash=?", hashToken(linkToken))
		if err != nil {
			return err
		}
		if err = s.liveSignInLink(ctx, tx, l); err != nil {
			return err
		}
		if err = s.signInAccountConflict(ctx, tx, currentToken, l.accountID, ""); err != nil {
			return err
		}
		r, err := readSignInRequest(ctx, tx, "link_id=? AND browser_token_hash=?", l.ID, hashToken(browser))
		if err == nil {
			if r.State == "denied" || r.State == "cancelled" {
				return ErrInvalidProof
			}
			result = SignInBeginResult{Request: r.SignInRequestView, BrowserSecret: browser, Code: r.code}
			return nil
		}
		if !errors.Is(err, ErrInvalidProof) {
			return err
		}
		if l.State != "open" {
			return ErrInvalidProof
		}
		var count int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM account_signin_requests WHERE link_id=? AND state='pending'", l.ID).Scan(&count); err != nil {
			return err
		}
		if count >= signInPendingLimit {
			return ErrSignInPendingCap
		}
		code, err := s.newSignInCode(ctx, tx, l.ID)
		if err != nil {
			return err
		}
		id := opaque()
		if _, err = tx.ExecContext(ctx, "INSERT INTO account_signin_requests(id,type,state,browser_token_hash,link_id,code,requester_user_agent,requester_ip,created_at,expires_at) VALUES(?,'link','pending',?,?,?,?,?,?,?)", id, hashToken(browser), l.ID, code, signInUA(ua), signInIP(requesterIP), s.now().Unix(), l.ExpiresAt.Unix()); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE account_signin_links SET last_notified_at=? WHERE id=?", s.now().Unix(), l.ID); err != nil {
			return err
		}
		r, err = readSignInRequest(ctx, tx, "id=?", id)
		if err != nil {
			return err
		}
		result = SignInBeginResult{Request: r.SignInRequestView, BrowserSecret: browser, Code: code}
		return s.appendRequestChange(ctx, tx, &e, id, true)
	})
	if err != nil {
		return SignInBeginResult{}, Effects{}, err
	}
	return result, e, nil
}

func (s *Service) approveRequest(ctx context.Context, tx *sql.Tx, r signInRequest, issuer Session, e *Effects) error {
	origin, err := s.initialPasskeyOrigin(ctx, tx, issuer.ID)
	if err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, "UPDATE account_signin_requests SET state='approved',version=version+1,approved_at=?,approved_by_session_id=?,approver_recent_proof=?,origin_passkey_credential_id=? WHERE id=? AND state='pending'", s.now().Unix(), issuer.ID, false, origin, r.ID)
	if err = affected(res, err, ErrSignInConflict); err != nil {
		return err
	}
	return s.appendRequestChange(ctx, tx, e, r.ID, true)
}

func (s *Service) ApproveSignInLink(ctx context.Context, token, id, code string) (SignInRequestView, Effects, error) {
	var result SignInRequestView
	var e Effects
	var rejection error
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		l, issuer, err := s.issuerLink(ctx, tx, token, id)
		if err != nil {
			return err
		}
		if l.State != "open" {
			return ErrInvalidProof
		}
		r, err := readSignInRequest(ctx, tx, "link_id=? AND code=? AND state='pending'", id, code)
		if errors.Is(err, ErrInvalidProof) {
			if _, err = tx.ExecContext(ctx, "UPDATE account_signin_links SET failed_code_attempts=failed_code_attempts+1 WHERE id=?", id); err != nil {
				return err
			}
			rejection = ErrInvalidProof
			if l.failures+1 >= signInCodeAttemptLimit {
				return s.cancelLink(ctx, tx, l, &e)
			}
			return nil
		}
		if err != nil {
			return err
		}
		competitors, err := signInRequests(ctx, tx, "link_id=? AND state='pending' AND id<>?", id, r.ID)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE account_signin_requests SET state='cancelled',version=version+1 WHERE link_id=? AND state='pending' AND id<>?", id, r.ID); err != nil {
			return err
		}
		if err = s.approveRequest(ctx, tx, r, issuer, &e); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE account_signin_links SET state='approved',version=version+1 WHERE id=? AND state='open'", id); err != nil {
			return err
		}
		for _, other := range competitors {
			if err = s.appendRequestChange(ctx, tx, &e, other.ID, true); err != nil {
				return err
			}
		}
		r, err = readSignInRequest(ctx, tx, "id=?", r.ID)
		result = r.SignInRequestView
		return err
	})
	if err != nil {
		return SignInRequestView{}, Effects{}, err
	}
	return result, e, rejection
}

func (s *Service) DenySignInRequest(ctx context.Context, token, linkID, requestID string) (Effects, error) {
	var e Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		l, _, err := s.issuerLink(ctx, tx, token, linkID)
		if err != nil {
			return err
		}
		if l.State != "open" {
			return ErrInvalidProof
		}
		r, err := readSignInRequest(ctx, tx, "id=? AND type='link' AND link_id=? AND state='pending'", requestID, linkID)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE account_signin_requests SET state='denied',version=version+1 WHERE id=?", r.ID); err != nil {
			return err
		}
		return s.appendRequestChange(ctx, tx, &e, r.ID, true)
	})
	if err != nil {
		return Effects{}, err
	}
	return e, nil
}

func (s *Service) boundRequest(ctx context.Context, tx *sql.Tx, id, browser string) (signInRequest, error) {
	if browser == "" {
		return signInRequest{}, ErrInvalidProof
	}
	r, err := readSignInRequest(ctx, tx, "id=? AND browser_token_hash=?", id, hashToken(browser))
	if err != nil {
		return r, err
	}
	if !s.now().Before(r.ExpiresAt) {
		return r, ErrInvalidProof
	}
	return r, nil
}

func (s *Service) validRequest(ctx context.Context, tx *sql.Tx, r signInRequest) error {
	if !s.now().Before(r.ExpiresAt) {
		return ErrInvalidProof
	}
	if r.State == "consumed" {
		_, err := s.sessionByID(ctx, tx, r.resultID)
		if errors.Is(err, ErrNoVisitor) {
			return ErrInvalidProof
		}
		return err
	}
	if r.State == "denied" || r.State == "cancelled" {
		return nil
	}
	if r.Type == "link" {
		l, err := readSignInLink(ctx, tx, "id=?", r.LinkID)
		if err != nil {
			return err
		}
		if r.ExpiresAt != l.ExpiresAt {
			return ErrInvalidProof
		}
		if err = s.liveSignInLink(ctx, tx, l); err != nil {
			return err
		}
		if r.State == "approved" && (l.State != "approved" || r.approver != l.issuer) {
			return ErrInvalidProof
		}
	}
	if r.State == "approved" {
		approver, err := s.sessionByID(ctx, tx, r.approver)
		if errors.Is(err, ErrNoVisitor) {
			return ErrInvalidProof
		}
		if err != nil {
			return err
		}
		if approver.Kind != Account {
			return ErrInvalidProof
		}
	}
	return nil
}

// SignInRequest is also the candidate stream admission/reconnect authorization seam.
func (s *Service) SignInRequest(ctx context.Context, id, browser string) (SignInRequestView, error) {
	var result SignInRequestView
	err := s.readSignInState(ctx, func(tx *sql.Tx) error {
		r, err := s.boundRequest(ctx, tx, id, browser)
		if err != nil {
			return err
		}
		if err = s.validRequest(ctx, tx, r); err != nil {
			return err
		}
		result = r.SignInRequestView
		return nil
	})
	return result, err
}

func (s *Service) ResendSignInRequest(ctx context.Context, id, browser, linkToken string) (Effects, error) {
	var e Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		r, err := s.boundRequest(ctx, tx, id, browser)
		if err != nil {
			return err
		}
		if r.Type != "link" || r.State != "pending" {
			return ErrInvalidProof
		}
		l, err := readSignInLink(ctx, tx, "id=? AND token_hash=?", r.LinkID, hashToken(linkToken))
		if err != nil {
			return err
		}
		if l.State != "open" {
			return ErrInvalidProof
		}
		if err = s.liveSignInLink(ctx, tx, l); err != nil {
			return err
		}
		if l.notified.Valid {
			retry := unixTime(l.notified.Int64).Add(SignInResendCooldown).Sub(s.now())
			if retry > 0 {
				return &SignInCooldownError{RetryAfter: retry}
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE account_signin_links SET last_notified_at=? WHERE id=?", s.now().Unix(), l.ID); err != nil {
			return err
		}
		return s.appendRequestChange(ctx, tx, &e, r.ID, true)
	})
	if err != nil {
		return Effects{}, err
	}
	return e, nil
}

func (s *Service) FinishSignInRequest(ctx context.Context, id, browser, linkToken, currentToken string) (SignInFinish, error) {
	var result SignInFinish
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		r, err := s.boundRequest(ctx, tx, id, browser)
		if err != nil {
			return err
		}
		if r.Type == "qr" && linkToken != "" {
			return ErrInvalidProof
		}
		if r.Type == "link" {
			l, err := readSignInLink(ctx, tx, "id=? AND token_hash=?", r.LinkID, hashToken(linkToken))
			if err != nil {
				return err
			}
			if r.ExpiresAt != l.ExpiresAt {
				return ErrInvalidProof
			}
		}
		if r.State != "approved" && r.State != "consumed" {
			return ErrInvalidProof
		}
		if err = s.validRequest(ctx, tx, r); err != nil {
			return err
		}
		if r.State == "consumed" {
			session, err := s.sessionByID(ctx, tx, r.resultID)
			if err != nil {
				return err
			}
			if err = s.signInAccountConflict(ctx, tx, currentToken, session.Visitor.ID, session.ID); err != nil {
				return err
			}
			token, err := openDelivery(browser, r)
			if err != nil {
				return err
			}
			current, err := s.currentToken(ctx, tx, token)
			if err != nil || current.ID != session.ID {
				return ErrInvalidProof
			}
			result.Session, result.Token = session, token
			return nil
		}
		approver, err := s.sessionByID(ctx, tx, r.approver)
		if err != nil {
			return err
		}
		if err = s.signInAccountConflict(ctx, tx, currentToken, approver.Visitor.ID, ""); err != nil {
			return err
		}
		result.Session, result.Token, err = s.issueAuthenticatedSession(ctx, tx, approver.Visitor.ID, Account, sessionAuthentication{method: "device_approval", authenticatedAt: r.ApprovedAt.Unix(), requestID: r.ID, originCredential: r.origin})
		if err != nil {
			return err
		}
		ciphertext, err := sealDelivery(browser, r, result.Session.ID, result.Token)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, "UPDATE account_signin_requests SET state='consumed',version=version+1,consumed_at=?,created_session_id=?,delivery_ciphertext=? WHERE id=? AND state='approved'", s.now().Unix(), result.Session.ID, ciphertext, r.ID)
		if err = affected(res, err, ErrInvalidProof); err != nil {
			return err
		}
		if r.Type == "link" {
			res, err = tx.ExecContext(ctx, "UPDATE account_signin_links SET state='consumed',version=version+1,consumed_at=? WHERE id=? AND state='approved'", s.now().Unix(), r.LinkID)
			if err = affected(res, err, ErrInvalidProof); err != nil {
				return err
			}
		}
		return s.appendRequestChange(ctx, tx, &result.Effects, r.ID, true)
	})
	if err != nil {
		return SignInFinish{}, err
	}
	return result, nil
}

func (s *Service) BeginQRSignIn(ctx context.Context, browser, currentToken, ua string, replace bool, allocate SignInAllocation, requesterIP ...string) (SignInBeginResult, Effects, error) {
	var result SignInBeginResult
	var e Effects
	if replace && browser == "" {
		return result, e, ErrInvalidProof
	}
	browser, err := signInBrowser(browser)
	if err != nil {
		return result, e, err
	}
	err = s.db.Write(ctx, func(tx *sql.Tx) error {
		if err := s.signInAccountConflict(ctx, tx, currentToken, "", ""); err != nil {
			return err
		}
		// Prefer the live flow; a successful older request may still retain metadata.
		old, err := readSignInRequest(ctx, tx, "id=(SELECT id FROM account_signin_requests WHERE type='qr' AND browser_token_hash=? ORDER BY CASE WHEN state IN ('pending','approved') THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1)", hashToken(browser))
		exists := err == nil
		if err != nil && !errors.Is(err, ErrInvalidProof) {
			return err
		}
		if replace && !exists {
			return ErrInvalidProof
		}
		live := exists && s.now().Before(old.ExpiresAt)
		if exists && old.State == "consumed" && replace {
			return ErrSignInConflict
		}
		if live && !replace {
			if old.State == "denied" || old.State == "cancelled" {
				return ErrInvalidProof
			}
			if err = s.validRequest(ctx, tx, old); err != nil {
				return err
			}
			token, err := qrToken(browser, old.ID)
			if err != nil {
				return err
			}
			result = SignInBeginResult{Request: old.SignInRequestView, BrowserSecret: browser, QRToken: token, URL: s.origin + "/#qr-signin=" + token}
			return nil
		}
		if allocate != nil {
			if err = allocate(base64.RawURLEncoding.EncodeToString(hashToken(browser))); err != nil {
				return err
			}
		}
		if exists && (old.State == "pending" || old.State == "approved") {
			if err = s.cancelRequest(ctx, tx, &e, old.ID, false); err != nil {
				return err
			}
		}
		id, now := opaque(), s.now().Unix()
		token, err := qrToken(browser, id)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO account_signin_requests(id,type,state,browser_token_hash,qr_token_hash,requester_user_agent,requester_ip,created_at,expires_at) VALUES(?,'qr','pending',?,?,?,?,?,?)", id, hashToken(browser), hashToken(token), signInUA(ua), signInIP(requesterIP), now, now+int64(SignInTTL/time.Second)); err != nil {
			return err
		}
		r, err := readSignInRequest(ctx, tx, "id=?", id)
		if err != nil {
			return err
		}
		result = SignInBeginResult{Request: r.SignInRequestView, BrowserSecret: browser, QRToken: token, URL: s.origin + "/#qr-signin=" + token}
		return nil
	})
	if err != nil {
		return SignInBeginResult{}, Effects{}, err
	}
	return result, e, nil
}

func (s *Service) pendingQR(ctx context.Context, tx *sql.Tx, token string) (signInRequest, error) {
	if token == "" {
		return signInRequest{}, ErrInvalidProof
	}
	r, err := readSignInRequest(ctx, tx, "type='qr' AND qr_token_hash=?", hashToken(token))
	if err != nil {
		return r, err
	}
	if !s.now().Before(r.ExpiresAt) || r.State == "cancelled" || r.State == "denied" {
		return r, ErrInvalidProof
	}
	if r.State != "pending" {
		return r, ErrSignInConflict
	}
	return r, nil
}

func (s *Service) PreviewQRSignIn(ctx context.Context, token, qr string) (SignInPreview, error) {
	var result SignInPreview
	err := s.readSignInState(ctx, func(tx *sql.Tx) error {
		_, err := s.ownerSession(ctx, tx, token, false)
		if err != nil {
			return err
		}
		r, err := s.pendingQR(ctx, tx, qr)
		if err != nil {
			return err
		}
		result.Request = r.SignInRequestView
		return nil
	})
	return result, err
}

func (s *Service) ApproveQRSignIn(ctx context.Context, token, qr string) (SignInRequestView, Effects, error) {
	var result SignInRequestView
	var e Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		approver, err := s.ownerSession(ctx, tx, token, false)
		if err != nil {
			return err
		}
		r, err := s.pendingQR(ctx, tx, qr)
		if err != nil {
			return err
		}
		if err = s.approveRequest(ctx, tx, r, approver, &e); err != nil {
			return err
		}
		r, err = readSignInRequest(ctx, tx, "id=?", r.ID)
		result = r.SignInRequestView
		return err
	})
	if err != nil {
		return SignInRequestView{}, Effects{}, err
	}
	return result, e, nil
}

func (s *Service) DenyQRSignIn(ctx context.Context, token, qr string) (Effects, error) {
	var e Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		if _, err := s.ownerSession(ctx, tx, token, false); err != nil {
			return err
		}
		r, err := s.pendingQR(ctx, tx, qr)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE account_signin_requests SET state='denied',version=version+1 WHERE id=? AND state='pending'", r.ID); err != nil {
			return err
		}
		return s.appendRequestChange(ctx, tx, &e, r.ID, false)
	})
	if err != nil {
		return Effects{}, err
	}
	return e, nil
}

func (s *Service) CancelQRSignIn(ctx context.Context, id, browser string) (Effects, error) {
	var e Effects
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		r, err := s.boundRequest(ctx, tx, id, browser)
		if err != nil {
			return err
		}
		if r.Type != "qr" {
			return ErrInvalidProof
		}
		if r.State == "consumed" {
			return ErrSignInConflict
		}
		if r.State == "cancelled" || r.State == "denied" {
			return nil
		}
		return s.cancelRequest(ctx, tx, &e, r.ID, false)
	})
	if err != nil {
		return Effects{}, err
	}
	return e, nil
}

func randomSignInCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(signInCodeSpace))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%0*d", signInCodeDigits, n.Int64()), nil
}
