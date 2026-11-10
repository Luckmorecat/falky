package identity_test

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestDeviceLinkApprovalAndBoundRedelivery(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, _ := enroll(t, f, "Alice")
	link, _, err := f.ident.CreateSignInLink(t.Context(), account.Token)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(link.URL, "https://falky.example/#signin=") {
		t.Fatal(link.URL)
	}
	begin, changes, err := f.ident.BeginSignInRequest(t.Context(), link.Token, "", "", "Browser")
	if err != nil {
		t.Fatal(err)
	}
	if len(begin.Code) != 4 || len(begin.BrowserSecret) != 52 || len(changes.SignInChanges) != 1 {
		t.Fatalf("begin=%+v effects=%+v", begin, changes)
	}
	resume, changes, err := f.ident.BeginSignInRequest(t.Context(), link.Token, begin.BrowserSecret, "", "Changed")
	if err != nil || resume.Request.ID != begin.Request.ID || resume.Code != begin.Code || len(changes.SignInChanges) != 0 {
		t.Fatalf("resume=%+v %v", resume, err)
	}
	f.clock.Advance(time.Minute)
	approvedAt := f.clock.Now()
	if _, _, err := f.ident.ApproveSignInLink(t.Context(), account.Token, link.Link.ID, begin.Code); err != nil {
		t.Fatal(err)
	}
	f.clock.Advance(time.Minute)
	finish, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, link.Token, "")
	if err != nil {
		t.Fatal(err)
	}
	if finish.Session.ID == account.Session.ID || finish.Session.Visitor.ID != account.Session.Visitor.ID || !finish.Session.ExpiresAt.Equal(f.clock.Now().Add(identity.AccountSessionTTL)) {
		t.Fatalf("finish=%+v", finish)
	}
	retry, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, link.Token, finish.Token)
	if err != nil || retry.Token != finish.Token || retry.Session.ID != finish.Session.ID {
		t.Fatalf("retry=%+v %v", retry, err)
	}
	var authenticated int64
	var count int
	if err := f.db.Read().QueryRowContext(t.Context(), "SELECT count(*),authenticated_at FROM session_authentications WHERE session_id=?", finish.Session.ID).Scan(&count, &authenticated); err != nil {
		t.Fatal(err)
	}
	if count != 1 || authenticated != approvedAt.Unix() {
		t.Fatalf("events=%d authenticated=%d", count, authenticated)
	}
	if _, err := f.ident.BeginAddPasskey(t.Context(), finish.Token, "browser"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, "", link.Token, ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("missing binding=%v", err)
	}
	if _, err := f.ident.Logout(t.Context(), account.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, link.Token, ""); err != nil {
		t.Fatal("approver logout broke consumed redelivery:", err)
	}
}

func TestDeviceQRResumeReplacementQuotaAndFirstApprover(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, _ := enroll(t, f, "Alice")
	b, _ := enroll(t, f, "Bob")
	allocations := 0
	allocate := func(browserHash string) error { allocations++; return nil }
	begin, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "Phone 📱", false, allocate)
	if err != nil {
		t.Fatal(err)
	}
	if begin.Code != "" || begin.QRToken == "" || !strings.HasPrefix(begin.URL, "https://falky.example/#qr-signin=") {
		t.Fatalf("qr=%+v", begin)
	}
	f.clock.Advance(time.Second)
	resume, _, err := f.ident.BeginQRSignIn(t.Context(), begin.BrowserSecret, "", "Different", false, allocate)
	if err != nil || resume.QRToken != begin.QRToken || resume.Request != begin.Request || allocations != 1 {
		t.Fatalf("resume=%+v allocations=%d %v", resume, allocations, err)
	}
	quota := errors.New("quota")
	if _, _, err := f.ident.BeginQRSignIn(t.Context(), begin.BrowserSecret, "", "", true, func(string) error { return quota }); !errors.Is(err, quota) {
		t.Fatal(err)
	}
	if preview, err := f.ident.PreviewQRSignIn(t.Context(), a.Token, begin.QRToken); err != nil || preview.Request.State != "pending" || preview.Request.Version != 1 {
		t.Fatalf("preview=%+v %v", preview, err)
	}
	if _, err := f.ident.PreviewQRSignIn(t.Context(), b.Token, begin.QRToken); err != nil {
		t.Fatal("scan claimed request", err)
	}
	if _, _, err := f.ident.ApproveQRSignIn(t.Context(), a.Token, begin.QRToken); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.ident.ApproveQRSignIn(t.Context(), b.Token, begin.QRToken); !errors.Is(err, identity.ErrSignInConflict) {
		t.Fatal("selection overwritten", err)
	}
	if _, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.QRToken, "", ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("qr token redeemed without binding", err)
	}
	finish, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, "", "")
	if err != nil || finish.Session.Visitor.ID != a.Session.Visitor.ID {
		t.Fatalf("finish=%+v %v", finish, err)
	}
	if _, _, err := f.ident.BeginQRSignIn(t.Context(), begin.BrowserSecret, "", "", true, allocate); !errors.Is(err, identity.ErrSignInConflict) {
		t.Fatal("replaced consumed QR", err)
	}
	if _, err := f.ident.CancelQRSignIn(t.Context(), begin.Request.ID, begin.BrowserSecret); !errors.Is(err, identity.ErrSignInConflict) {
		t.Fatal("cancelled consumed QR", err)
	}
	other, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, allocate)
	if err != nil {
		t.Fatal(err)
	}
	replacement, changes, err := f.ident.BeginQRSignIn(t.Context(), other.BrowserSecret, "", "", true, allocate)
	if err != nil || replacement.Request.ID == other.Request.ID || replacement.QRToken == other.QRToken || len(changes.SignInChanges) != 1 {
		t.Fatalf("replacement=%+v changes=%+v %v", replacement, changes, err)
	}
	if _, err := f.ident.PreviewQRSignIn(t.Context(), a.Token, other.QRToken); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal(err)
	}
	if _, err := f.ident.DenyQRSignIn(t.Context(), a.Token, replacement.QRToken); err != nil {
		t.Fatal(err)
	}
	if state, err := f.ident.SignInRequest(t.Context(), replacement.Request.ID, replacement.BrowserSecret); err != nil || state.State != "denied" {
		t.Fatalf("deny=%+v %v", state, err)
	}
}

func TestDeviceApproverLogoutCancelsUnconsumedAndPublishesTerminalChanges(t *testing.T) {
	for _, flow := range []string{"link", "qr"} {
		t.Run(flow, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			a, _ := enroll(t, f, "Alice")
			var begin identity.SignInBeginResult
			var token string
			if flow == "link" {
				l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
				if err != nil {
					t.Fatal(err)
				}
				token = l.Token
				begin, _, err = f.ident.BeginSignInRequest(t.Context(), l.Token, "", "", "")
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err = f.ident.ApproveSignInLink(t.Context(), a.Token, l.Link.ID, begin.Code); err != nil {
					t.Fatal(err)
				}
			} else {
				var err error
				begin, _, err = f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err = f.ident.ApproveQRSignIn(t.Context(), a.Token, begin.QRToken); err != nil {
					t.Fatal(err)
				}
			}
			effects, err := f.ident.Logout(t.Context(), a.Token)
			if err != nil {
				t.Fatal(err)
			}
			if len(effects.SignInChanges) != 1 || effects.SignInChanges[0].Request.State != "cancelled" || effects.SignInChanges[0].Request.Version != 3 {
				t.Fatalf("logout effects=%+v", effects)
			}
			if _, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, token, ""); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatal("unconsumed authorization survived logout", err)
			}
		})
	}
}

func TestDeviceLinkCapacityDenialStableZeroCodeAndExactIssuer(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, key := enroll(t, f, "Alice")
	login, err := f.ident.BeginAuthentication(t.Context(), "another")
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.ident.FinishAuthentication(t.Context(), login.ID, "another", key.Assertion(t, login.Assertion, "https://falky.example"))
	if err != nil {
		t.Fatal(err)
	}
	sequence := []string{"0000", "0000", "0001", "0002", "0003"}
	index := 0
	f.ident = identity.New(f.db, "https://falky.example", identity.WithClock(f.clock.Now), identity.WithSignInCodeGenerator(func() (string, error) { v := sequence[index]; index++; return v, nil }))
	l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
	if err != nil {
		t.Fatal(err)
	}
	var candidates []identity.SignInBeginResult
	for range 3 {
		c, _, err := f.ident.BeginSignInRequest(t.Context(), l.Token, "", "", strings.Repeat("界", 300))
		if err != nil {
			t.Fatal(err)
		}
		candidates = append(candidates, c)
	}
	if candidates[0].Code != "0000" || candidates[1].Code != "0001" || len([]rune(candidates[0].Request.RequesterUserAgent)) != 256 {
		t.Fatalf("codes/UA=%+v", candidates)
	}
	if _, _, err := f.ident.BeginSignInRequest(t.Context(), l.Token, "", "", ""); !errors.Is(err, identity.ErrSignInPendingCap) {
		t.Fatal("cap", err)
	}
	if _, _, err := f.ident.ApproveSignInLink(t.Context(), other.Token, l.Link.ID, "0000"); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("other session approved", err)
	}
	if _, err := f.ident.SignInLink(t.Context(), other.Token, l.Link.ID); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("other session observed", err)
	}
	if _, err := f.ident.DenySignInRequest(t.Context(), a.Token, l.Link.ID, candidates[0].Request.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.ident.BeginSignInRequest(t.Context(), l.Token, candidates[0].BrowserSecret, "", ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("denied browser rejoined", err)
	}
	if _, _, err := f.ident.BeginSignInRequest(t.Context(), l.Token, "", "", ""); err != nil {
		t.Fatal("deny did not release slot", err)
	}
	if _, _, err := f.ident.ApproveSignInLink(t.Context(), a.Token, l.Link.ID, "0001"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.ident.CreateSignInLink(t.Context(), a.Token); err != nil {
		t.Fatal(err)
	}
	if r, err := f.ident.SignInRequest(t.Context(), candidates[1].Request.ID, candidates[1].BrowserSecret); err != nil || r.State != "cancelled" {
		t.Fatalf("reissue approved=%+v %v", r, err)
	}
	_, guest := f.enter(t, "Guest")
	if _, _, err := f.ident.CreateSignInLink(t.Context(), guest); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatal("guest issued link", err)
	}
}

func deviceQR(t *testing.T, f fixture, approver string) (identity.SignInBeginResult, identity.SignInFinish) {
	t.Helper()
	q, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.ident.ApproveQRSignIn(t.Context(), approver, q.QRToken); err != nil {
		t.Fatal(err)
	}
	finish, err := f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", "")
	if err != nil {
		t.Fatal(err)
	}
	return q, finish
}

func TestDeviceFreshnessCannotChainAndUsesApprovalTime(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, _ := enroll(t, f, "Alice")
	_, first := deviceQR(t, f, a.Token)
	if _, err := f.ident.BeginAddPasskey(t.Context(), first.Token, "add"); err != nil {
		t.Fatal("fresh actual passkey proof not copied", err)
	}
	q, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := f.ident.PreviewQRSignIn(t.Context(), first.Token, q.QRToken)
	if err != nil || preview.ApprovalGrantsRecentProof {
		t.Fatalf("device proof chain preview=%+v %v", preview, err)
	}
	if _, _, err = f.ident.ApproveQRSignIn(t.Context(), first.Token, q.QRToken); err != nil {
		t.Fatal(err)
	}
	chained, err := f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.ident.BeginAddPasskey(t.Context(), chained.Token, "add"); !errors.Is(err, identity.ErrRecentProof) {
		t.Fatal("device approval chained proof", err)
	}
	f.clock.Advance(identity.RecentProofTTL - time.Second)
	q, _, err = f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.ident.ApproveQRSignIn(t.Context(), a.Token, q.QRToken); err != nil {
		t.Fatal(err)
	}
	f.clock.Advance(2 * time.Second)
	delayed, err := f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", "")
	if err != nil {
		t.Fatal(err)
	}
	// Freshness begins at approval, even though the original passkey proof is older now.
	if _, err = f.ident.BeginAddPasskey(t.Context(), delayed.Token, "add"); err != nil {
		t.Fatal(err)
	}
	stale, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.ident.PreviewQRSignIn(t.Context(), a.Token, stale.QRToken)
	if err != nil || p.ApprovalGrantsRecentProof {
		t.Fatalf("stale preview=%+v %v", p, err)
	}
	if _, _, err = f.ident.ApproveQRSignIn(t.Context(), a.Token, stale.QRToken); err != nil {
		t.Fatal("stale session cannot approve", err)
	}
	d, err := f.ident.FinishSignInRequest(t.Context(), stale.Request.ID, stale.BrowserSecret, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.ident.BeginAddPasskey(t.Context(), d.Token, "add"); !errors.Is(err, identity.ErrRecentProof) {
		t.Fatal(err)
	}
	f.clock.Advance(identity.RecentProofTTL - 2*time.Second)
	if _, err = f.ident.BeginAddPasskey(t.Context(), delayed.Token, "add"); !errors.Is(err, identity.ErrRecentProof) {
		t.Fatal("redemption refreshed proof", err)
	}
}

func TestDeviceAccountConflictsPreserveRequestAndGuestIdentity(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, key := enroll(t, f, "Alice")
	b, _ := enroll(t, f, "Bob")
	l, _, err := f.ident.CreateSignInLink(t.Context(), a.Token)
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		token string
		want  error
	}{{a.Token, identity.ErrAlreadySignedIn}, {b.Token, identity.ErrAccountSwitchRequired}} {
		if _, _, err = f.ident.BeginSignInRequest(t.Context(), l.Token, "", tt.token, ""); !errors.Is(err, tt.want) {
			t.Fatalf("begin=%v", err)
		}
		if _, _, err = f.ident.BeginQRSignIn(t.Context(), "", tt.token, "", false, nil); !errors.Is(err, identity.ErrAlreadySignedIn) {
			t.Fatalf("QR create=%v", err)
		}
	}
	q, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.ident.ApproveQRSignIn(t.Context(), a.Token, q.QRToken); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		token string
		want  error
	}{{a.Token, identity.ErrAlreadySignedIn}, {b.Token, identity.ErrAccountSwitchRequired}} {
		if _, err = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", tt.token); !errors.Is(err, tt.want) {
			t.Fatalf("finish=%v", err)
		}
	}
	guest, guestToken := f.enter(t, "Guest")
	finish, err := f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", guestToken)
	if err != nil {
		t.Fatal(err)
	}
	if finish.Session.Visitor.ID != a.Session.Visitor.ID {
		t.Fatal("wrong selected account")
	}
	if current, err := f.ident.ResolveSession(t.Context(), guestToken); err != nil || current.Visitor.ID != guest.ID {
		t.Fatal("guest identity merged/deleted", err)
	}
	login, err := f.ident.BeginAuthentication(t.Context(), "newer")
	if err != nil {
		t.Fatal(err)
	}
	newer, err := f.ident.FinishAuthentication(t.Context(), login.ID, "newer", key.Assertion(t, login.Assertion, "https://falky.example"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		token string
		want  error
	}{{newer.Token, identity.ErrAlreadySignedIn}, {b.Token, identity.ErrAccountSwitchRequired}} {
		if _, err = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", tt.token); !errors.Is(err, tt.want) {
			t.Fatalf("redelivery overwrote current session=%v", err)
		}
	}
	if _, err = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", finish.Token); err != nil {
		t.Fatal(err)
	}
	effects, err := f.ident.Logout(t.Context(), finish.Token)
	if err != nil {
		t.Fatal(err)
	}
	if len(effects.SignInChanges) != 1 || effects.SignInChanges[0].Request.State != "cancelled" {
		t.Fatalf("target logout=%+v", effects)
	}
	if _, err = f.ident.FinishSignInRequest(t.Context(), q.Request.ID, q.BrowserSecret, "", ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatal("revoked target redelivered", err)
	}
}

func TestDeviceQRExplicitReplacementRequiresOriginalBinding(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	q, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	allocations := 0
	for _, browser := range []string{"", strings.Repeat("X", 52)} {
		if _, _, err = f.ident.BeginQRSignIn(t.Context(), browser, "", "", true, func(string) error { allocations++; return nil }); !errors.Is(err, identity.ErrInvalidProof) {
			t.Fatalf("unbound replacement=%v", err)
		}
	}
	if allocations != 0 {
		t.Fatal("unbound replacement allocated")
	}
	if state, err := f.ident.SignInRequest(t.Context(), q.Request.ID, q.BrowserSecret); err != nil || state.State != "pending" {
		t.Fatalf("original request=%+v %v", state, err)
	}
}

func TestDeviceConsumedRetryProtectsDifferentGuestSession(t *testing.T) {
	for _, flow := range []string{"link", "qr"} {
		t.Run(flow, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			account, _ := enroll(t, f, "Alice")
			initialGuest, initialGuestToken := f.enter(t, "Initial guest")
			var begin identity.SignInBeginResult
			linkToken := ""
			if flow == "link" {
				link, _, err := f.ident.CreateSignInLink(t.Context(), account.Token)
				if err != nil {
					t.Fatal(err)
				}
				linkToken = link.Token
				begin, _, err = f.ident.BeginSignInRequest(t.Context(), link.Token, "", initialGuestToken, "")
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err = f.ident.ApproveSignInLink(t.Context(), account.Token, link.Link.ID, begin.Code); err != nil {
					t.Fatal(err)
				}
			} else {
				var err error
				begin, _, err = f.ident.BeginQRSignIn(t.Context(), "", initialGuestToken, "", false, nil)
				if err != nil {
					t.Fatal(err)
				}
				if _, _, err = f.ident.ApproveQRSignIn(t.Context(), account.Token, begin.QRToken); err != nil {
					t.Fatal(err)
				}
			}
			finish, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, linkToken, initialGuestToken)
			if err != nil {
				t.Fatal("first guest finish refused", err)
			}
			if guest, err := f.ident.ResolveSession(t.Context(), initialGuestToken); err != nil || guest.Visitor.ID != initialGuest.ID {
				t.Fatal("first guest identity changed", err)
			}
			before, err := f.ident.SignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret)
			if err != nil {
				t.Fatal(err)
			}
			f.clock.Advance(time.Second)
			newerGuest, newerGuestToken := f.enter(t, "Newer guest")
			rejected, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, linkToken, newerGuestToken)
			if !errors.Is(err, identity.ErrSignInConflict) || rejected.Token != "" || rejected.Session.ID != "" {
				t.Fatalf("consumed retry overwrote different guest: %+v %v", rejected, err)
			}
			if guest, err := f.ident.ResolveSession(t.Context(), newerGuestToken); err != nil || guest.Visitor.ID != newerGuest.ID {
				t.Fatal("newer guest identity changed", err)
			}
			after, err := f.ident.SignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("conflict changed request: before=%+v after=%+v %v", before, after, err)
			}
			for _, current := range []string{"", finish.Token} {
				retry, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, linkToken, current)
				if err != nil || retry.Token != finish.Token || retry.Session.ID != finish.Session.ID {
					t.Fatalf("allowed retry=%+v %v", retry, err)
				}
			}
			var events int
			if err = f.db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM session_authentications WHERE device_approval_request_id=?", begin.Request.ID).Scan(&events); err != nil || events != 1 {
				t.Fatalf("initial device events=%d %v", events, err)
			}
			if _, err = f.ident.Logout(t.Context(), newerGuestToken); err != nil {
				t.Fatal(err)
			}
			if retry, err := f.ident.FinishSignInRequest(t.Context(), begin.Request.ID, begin.BrowserSecret, linkToken, newerGuestToken); err != nil || retry.Token != finish.Token {
				t.Fatalf("inactive guest blocks retry=%+v %v", retry, err)
			}
		})
	}
}
