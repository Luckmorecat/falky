package identity_test

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func TestPasskeyCreationAcceptsMissingCredProps(t *testing.T) {
	for _, flow := range []string{"registration", "recovery", "add"} {
		t.Run(flow, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			var ceremony identity.Ceremony
			var finish func([]byte) error
			var err error
			switch flow {
			case "registration":
				invite, createErr := f.ident.CreateInvitation(t.Context())
				if createErr != nil {
					t.Fatal(createErr)
				}
				ceremony, err = f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: invite.Token, Name: "Alice", BrowserContext: "browser"})
				finish = func(response []byte) error {
					_, err := f.ident.FinishRegistration(t.Context(), ceremony.ID, "browser", response, "Phone")
					return err
				}
			case "recovery":
				account, _ := enroll(t, f, "Alice")
				ceremony, err = f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, account.RecoveryCodes[0], "browser")
				finish = func(response []byte) error {
					_, err := f.ident.FinishRecovery(t.Context(), ceremony.ID, "browser", response, "Phone")
					return err
				}
			case "add":
				account, _ := enroll(t, f, "Alice")
				ceremony, err = f.ident.BeginAddPasskey(t.Context(), account.Token, "browser")
				finish = func(response []byte) error {
					_, err := f.ident.FinishAddPasskey(t.Context(), account.Token, ceremony.ID, "browser", response, "Phone")
					return err
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			selection := ceremony.Creation.Response.AuthenticatorSelection
			if selection.ResidentKey != protocol.ResidentKeyRequirementRequired || selection.RequireResidentKey == nil || !*selection.RequireResidentKey || selection.UserVerification != protocol.VerificationRequired {
				t.Fatalf("creation must require discoverability and user verification: %+v", selection)
			}

			key := passkeytest.New(t)
			key.UserVerified = false
			if err := finish(withoutCredProps(t, key.Registration(t, ceremony.Creation, "https://falky.example"))); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatalf("missing user verification without credProps = %v", err)
			}
			key.UserVerified = true
			key.Discoverable = false
			if err := finish(key.Registration(t, ceremony.Creation, "https://falky.example")); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatalf("explicit rk=false = %v", err)
			}
			key.Discoverable = true
			if err := finish(withoutCredProps(t, key.Registration(t, ceremony.Creation, "https://falky.example"))); err != nil {
				t.Fatalf("valid credential without credProps = %v", err)
			}

			login, err := f.ident.BeginAuthentication(t.Context(), "login-browser")
			if err != nil {
				t.Fatal(err)
			}
			account, err := f.ident.FinishAuthentication(t.Context(), login.ID, "login-browser", key.Assertion(t, login.Assertion, "https://falky.example"))
			if err != nil {
				t.Fatal("credential enrolled without credProps cannot sign in:", err)
			}
			if account.Session.Kind != identity.Account || account.Session.Visitor.Name != "Alice" {
				t.Fatalf("unexpected signed-in identity: %+v", account.Session)
			}
		})
	}
}

func withoutCredProps(t *testing.T, response []byte) []byte {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response, &body); err != nil {
		t.Fatal(err)
	}
	body["clientExtensionResults"] = map[string]any{}
	result, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
