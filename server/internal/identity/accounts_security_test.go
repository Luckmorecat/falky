package identity_test

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func TestFirstArrivalNeedsOnlyInvitationAndCreatesAccountOnlyAfterVerifiedEnrollment(t *testing.T) {
	db := openDB(t, filepath.Join(t.TempDir(), "falky.db"))
	s := identity.New(db, "https://falky.example")
	i, err := s.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: i.Token, Name: "Alice", BrowserContext: "browser"})
	if err != nil {
		t.Fatal(err)
	}
	id := string(c.Creation.Response.User.ID.(protocol.URLEncodedBase64))
	if _, err := s.AccountInfo(t.Context(), id); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("partial account before finish = %v", err)
	}
	k := passkeytest.New(t)
	if _, err := s.FinishRegistration(t.Context(), c.ID, "browser", k.Registration(t, c.Creation, "https://evil.example"), ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("cross-origin enrollment = %v", err)
	}
	if _, err := s.AccountInfo(t.Context(), id); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("partial account after bad finish = %v", err)
	}
	result, err := s.FinishRegistration(t.Context(), c.ID, "browser", k.Registration(t, c.Creation, "https://falky.example"), "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Session.Visitor.ID != id {
		t.Fatal("fresh registration changed the authenticator's user handle")
	}
	if _, err := s.ResolveSession(t.Context(), result.Token); err != nil {
		t.Fatal(err)
	}
}

func TestSignedFixtureAcceptsWireDecodedCreationOptions(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	i, err := f.ident.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	c, err := f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: i.Token, Name: "Alice", BrowserContext: "browser"})
	if err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(c.Creation)
	if err != nil {
		t.Fatal(err)
	}
	var decoded protocol.CredentialCreation
	if err = json.Unmarshal(wire, &decoded); err != nil {
		t.Fatal(err)
	}
	key := passkeytest.New(t)
	if _, err = f.ident.FinishRegistration(t.Context(), c.ID, "browser", key.Registration(t, &decoded, "https://falky.example"), ""); err != nil {
		t.Fatal(err)
	}
}

func TestEnrollmentRejectsWrongContextMissingUVNonDiscoverableAndBadSignature(t *testing.T) {
	for _, failure := range []string{"context", "uv", "discoverable", "signature", "challenge", "rp"} {
		t.Run(failure, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			i, err := f.ident.CreateInvitation(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			c, err := f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: i.Token, Name: "Alice", BrowserContext: "browser"})
			if err != nil {
				t.Fatal(err)
			}
			key := passkeytest.New(t)
			browser := "browser"
			switch failure {
			case "context":
				browser = "other"
			case "uv":
				key.UserVerified = false
			case "discoverable":
				key.Discoverable = false
			case "signature":
				key.CorruptSignature = true
			case "challenge":
				c.Creation.Response.Challenge = make([]byte, 32)
			case "rp":
				c.Creation.Response.RelyingParty.ID = "evil.example"
			}
			response := key.Registration(t, c.Creation, "https://falky.example")
			if _, err := f.ident.FinishRegistration(t.Context(), c.ID, browser, response, ""); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatalf("invalid %s enrollment = %v", failure, err)
			}
			invites, err := f.ident.Invitations(t.Context())
			if err != nil || len(invites) != 1 || invites[0].Redeemed {
				t.Fatal("failed enrollment consumed invitation")
			}
		})
	}
}

func TestAuthenticationRequiresRealSignatureUserVerificationOriginAndAccountHandle(t *testing.T) {
	for _, failure := range []string{"signature", "uv", "origin", "handle", "rp", "challenge"} {
		t.Run(failure, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			_, key := enroll(t, f, "Alice")
			c, err := f.ident.BeginAuthentication(t.Context(), "browser")
			if err != nil {
				t.Fatal(err)
			}
			origin := "https://falky.example"
			switch failure {
			case "signature":
				key.Key = passkeytest.New(t).Key
			case "uv":
				key.UserVerified = false
			case "origin":
				origin = "https://evil.example"
			case "handle":
				key.UserHandle = []byte("other-account")
			case "rp":
				c.Assertion.Response.RelyingPartyID = "evil.example"
			case "challenge":
				c.Assertion.Response.Challenge = make([]byte, 32)
			}
			if _, err := f.ident.FinishAuthentication(t.Context(), c.ID, "browser", key.Assertion(t, c.Assertion, origin)); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatalf("invalid %s authentication = %v", failure, err)
			}
		})
	}
}

func TestInvitationAndCeremonyExpireAndInvitationCanBeRevoked(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	i, err := f.ident.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if i.ExpiresAt.Sub(i.CreatedAt) != 7*24*time.Hour {
		t.Fatal("invitation does not last seven days")
	}
	c, err := f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: i.Token, Name: "Alice", BrowserContext: "browser"})
	if err != nil {
		t.Fatal(err)
	}
	key := passkeytest.New(t)
	response := key.Registration(t, c.Creation, "https://falky.example")
	f.clock.Advance(identity.CeremonyTTL)
	if _, err := f.ident.FinishRegistration(t.Context(), c.ID, "browser", response, ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("expired ceremony = %v", err)
	}
	if _, err := f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: i.Token, Name: "Alice", BrowserContext: "browser"}); err != nil {
		t.Fatal("expired ceremony consumed invitation")
	}
	f.clock.Advance(identity.InvitationTTL - identity.CeremonyTTL)
	if _, err := f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: i.Token, Name: "Alice", BrowserContext: "browser"}); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("expired invitation = %v", err)
	}
	i, err = f.ident.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	c, err = f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: i.Token, Name: "Alice", BrowserContext: "browser"})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.ident.RevokeInvitation(t.Context(), i.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ident.FinishRegistration(t.Context(), c.ID, "browser", key.Registration(t, c.Creation, "https://falky.example"), ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("revoked invitation = %v", err)
	}
}

func TestConcurrentInvitationRedemptionCreatesExactlyOneAccount(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	i, err := f.ident.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	var attempts []struct {
		id       string
		response []byte
	}
	for _, name := range []string{"Alice", "Bob"} {
		c, err := f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: i.Token, Name: name, BrowserContext: "browser"})
		if err != nil {
			t.Fatal(err)
		}
		key := passkeytest.New(t)
		response := key.Registration(t, c.Creation, "https://falky.example")
		attempts = append(attempts, struct {
			id       string
			response []byte
		}{c.ID, response})
	}
	for _, attempt := range attempts {
		wg.Go(func() {
			_, err := f.ident.FinishRegistration(t.Context(), attempt.id, "browser", attempt.response, "")
			results <- err
		})
	}
	wg.Wait()
	close(results)
	var winners, losers int
	for err := range results {
		switch {
		case err == nil:
			winners++
		case errors.Is(err, identity.ErrInvalidProof):
			losers++
		default:
			t.Fatal(err)
		}
	}
	if winners != 1 || losers != 1 {
		t.Fatalf("invitation winners=%d losers=%d", winners, losers)
	}
	list, err := f.ident.Invitations(t.Context())
	if err != nil || len(list) != 1 || !list[0].Redeemed || list[0].Token != "" || list[0].Link != "" {
		t.Fatal("invitation list exposed bearer or missed redemption")
	}
}

func TestAccountNameClaimDisplacesEveryCollidingGuestAndStaysReservedWhenDisabled(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	a, tokenA := f.enter(t, "Alice")
	f.clock.Advance(time.Minute)
	b, tokenB := f.enter(t, "ALICE")
	closeGuest := f.connect(t, b)
	defer closeGuest(true)
	account, _ := enroll(t, f, "alice")
	if len(account.Effects.Displaced) != 2 {
		t.Fatalf("displaced guests=%d", len(account.Effects.Displaced))
	}
	aNow, err := f.ident.Resolve(t.Context(), tokenA)
	if err != nil {
		t.Fatal(err)
	}
	bNow, err := f.ident.Resolve(t.Context(), tokenB)
	if err != nil {
		t.Fatal(err)
	}
	if aNow.ID != a.ID || bNow.ID != b.ID || aNow.Name == a.Name || bNow.Name == b.Name || identity.NameKey(aNow.Name) == identity.NameKey(bNow.Name) {
		t.Fatal("guest displacement lost identity or produced colliding names")
	}
	if aNow.Colour != a.Colour || bNow.Colour != b.Colour {
		t.Fatal("displacement changed guest colour")
	}
	if _, err := f.ident.DisableAccount(t.Context(), account.Session.Visitor.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.ident.Enter(t.Context(), f.secret, "Alice"); !errors.Is(err, identity.ErrNameTaken) {
		t.Fatalf("disabled name released = %v", err)
	}
	if _, err := f.ident.Rename(t.Context(), a.ID, "Alice"); !errors.Is(err, identity.ErrNameTaken) {
		t.Fatalf("guest stole disabled name = %v", err)
	}
}

func TestDisableRejectsStaleSessionsAuthenticationRecoveryAndKeepsGuestLink(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, key := enroll(t, f, "Alice")
	grant, err := f.ident.IssueRecovery(t.Context(), account.Session.Visitor.ID)
	if err != nil {
		t.Fatal(err)
	}
	login, err := f.ident.BeginAuthentication(t.Context(), "browser")
	if err != nil {
		t.Fatal(err)
	}
	recovering, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, grant.Token, "browser")
	if err != nil {
		t.Fatal(err)
	}
	effects, err := f.ident.DisableAccount(t.Context(), account.Session.Visitor.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !effects.AccountDisabled || effects.RevokedIdentity != account.Session.Visitor.ID || len(effects.RevokedSessions) != 1 {
		t.Fatal("disable omitted required effects")
	}
	if _, err := f.ident.ValidateSession(t.Context(), account.Session); !errors.Is(err, identity.ErrNoVisitor) {
		t.Fatalf("disabled snapshot = %v", err)
	}
	if _, err := f.ident.FinishAuthentication(t.Context(), login.ID, "browser", key.Assertion(t, login.Assertion, "https://falky.example")); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("disabled authentication = %v", err)
	}
	if _, err := f.ident.IssueRecovery(t.Context(), account.Session.Visitor.ID); !errors.Is(err, identity.ErrDisabled) {
		t.Fatalf("disabled recovery issuance = %v", err)
	}
	replacement := passkeytest.New(t)
	if _, err := f.ident.FinishRecovery(t.Context(), recovering.ID, "browser", replacement.Registration(t, recovering.Creation, "https://falky.example"), ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("disabled recovery completion = %v", err)
	}
	guest, _ := f.enter(t, "New guest")
	if guest.ID == account.Session.Visitor.ID {
		t.Fatal("disabled account regained access through guest identity")
	}
	info, err := f.ident.AccountInfo(t.Context(), account.Session.Visitor.ID)
	if err != nil || !info.Disabled || info.Name != "Alice" {
		t.Fatal("disable lost persistent account")
	}
}

func TestRecoveryCodesAreStoredAsHashesAndRegenerationInvalidatesOldProofs(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, _ := enroll(t, f, "Alice")
	rows, err := f.db.Read().QueryContext(t.Context(), "SELECT token_hash FROM account_recovery_proofs WHERE identity_id=?", account.Session.Visitor.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := map[[32]byte]bool{}
	for _, code := range account.RecoveryCodes {
		if len(code) < 40 {
			t.Fatal("recovery code has insufficient entropy")
		}
		want[sha256.Sum256([]byte(code))] = true
	}
	var count int
	for rows.Next() {
		var hash []byte
		if err := rows.Scan(&hash); err != nil {
			t.Fatal(err)
		}
		if len(hash) != 32 || !want[[32]byte(hash)] {
			t.Fatal("stored recovery proof is not the code's SHA-256 digest")
		}
		count++
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		t.Fatal(err)
	}
	if count != 10 {
		t.Fatalf("stored recovery digests=%d", count)
	}
	pending, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, account.RecoveryCodes[0], "browser")
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := f.ident.RegenerateRecoveryCodes(t.Context(), account.Token)
	if err != nil {
		t.Fatal(err)
	}
	key := passkeytest.New(t)
	if _, err := f.ident.FinishRecovery(t.Context(), pending.ID, "browser", key.Registration(t, pending.Creation, "https://falky.example"), ""); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("old code ceremony after regeneration = %v", err)
	}
	if _, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, fresh[0], "browser"); err != nil {
		t.Fatal(err)
	}
}
