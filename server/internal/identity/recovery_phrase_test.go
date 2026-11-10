package identity_test

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func assertRecoveryPhrase(t *testing.T, codes []string) {
	t.Helper()
	if len(codes) != 1 {
		t.Fatalf("recovery phrase count=%d, want 1", len(codes))
	}
	data, err := os.ReadFile("eff_short_wordlist_1.txt")
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprintf("%x", sha256.Sum256(data)) != "8f5ca830b8bffb6fe39c9736c024a00a6a6411adb3f83a9be8bfeeb6e067ae69" {
		t.Fatal("dictionary differs from the EFF short wordlist #1 source")
	}
	dictionary := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		entry := strings.Fields(line)
		if len(entry) != 2 {
			t.Fatal("invalid dictionary entry")
		}
		dictionary[entry[1]] = true
	}
	words := strings.Split(codes[0], " ")
	if len(dictionary) != 1296 || len(words) != 12 {
		t.Fatal("expected twelve words from the 1296-word dictionary")
	}
	for _, word := range words {
		if !dictionary[word] {
			t.Fatal("recovery phrase contains a word outside the EFF short wordlist #1")
		}
	}
}

func TestRecoveryPhraseAcceptsFormattingButRequiresExactWordsAndAccount(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, _ := enroll(t, f, "Alice")
	phrase := account.RecoveryCodes[0]
	words := strings.Fields(phrase)
	wrong := append([]string(nil), words...)
	wrong[0] += "x"
	reordered := append([]string(nil), words...)
	for i := 1; i < len(reordered); i++ {
		if reordered[i] != reordered[0] {
			reordered[0], reordered[i] = reordered[i], reordered[0]
			break
		}
	}
	for name, proof := range map[string]string{
		"wrong spelling": strings.Join(wrong, " "),
		"missing word":   strings.Join(words[1:], " "),
		"extra word":     phrase + " acid",
		"empty":          " \t\n ",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, proof, "browser"); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatalf("invalid phrase accepted: %v", err)
			}
		})
	}
	if strings.Join(reordered, " ") != phrase {
		if _, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, strings.Join(reordered, " "), "browser"); !errors.Is(err, identity.ErrInvalidProof) {
			t.Fatalf("reordered phrase accepted: %v", err)
		}
	}
	if _, err := f.ident.BeginRecovery(t.Context(), "other-account", phrase, "browser"); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("phrase accepted for another account: %v", err)
	}
	formatted := " \t" + strings.ToUpper(strings.Join(words, " \t\n  ")) + "\n "
	pending, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, formatted, "browser")
	if err != nil {
		t.Fatal("formatted phrase rejected:", err)
	}
	if _, err := f.ident.FinishRecovery(t.Context(), pending.ID, "browser", []byte(`{}`), ""); err == nil {
		t.Fatal("invalid passkey enrollment succeeded")
	}
	// Starting and abandoning another ceremony must not consume the phrase.
	if _, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, phrase, "abandoned"); err != nil {
		t.Fatal(err)
	}
	key := passkeytest.New(t)
	result, err := f.ident.FinishRecovery(t.Context(), pending.ID, "browser", key.Registration(t, pending.Creation, "https://falky.example"), "Replacement")
	if err != nil {
		t.Fatal("formatted proof did not survive completion:", err)
	}
	assertRecoveryPhrase(t, result.RecoveryCodes)
}

func TestOperatorRecoveryBearerRemainsExact(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, _ := enroll(t, f, "Alice")
	grant, err := f.ident.IssueRecovery(t.Context(), account.Session.Visitor.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, proof := range []string{strings.ToLower(grant.Token), " " + grant.Token, grant.Token + "\t\n"} {
		if _, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, proof, "browser"); !errors.Is(err, identity.ErrInvalidProof) {
			t.Fatalf("modified operator bearer accepted: %v", err)
		}
	}
	if _, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, grant.Token, "browser"); err != nil {
		t.Fatal(err)
	}
	f.clock.Advance(identity.OperatorRecoveryTTL)
	if _, err := f.ident.BeginRecovery(t.Context(), account.Session.Visitor.ID, grant.Token, "browser"); !errors.Is(err, identity.ErrInvalidProof) {
		t.Fatalf("expired operator bearer accepted: %v", err)
	}
}
