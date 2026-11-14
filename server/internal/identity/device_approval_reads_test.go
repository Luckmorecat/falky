package identity_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
)

func TestDeviceReadOnlyStateDoesNotWaitForWriter(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	account, _ := enroll(t, f, "Account")
	link, _, err := f.ident.CreateSignInLink(t.Context(), account.Token)
	if err != nil {
		t.Fatal(err)
	}
	qr, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- f.db.Write(t.Context(), func(*sql.Tx) error { close(entered); <-release; return nil }) }()
	<-entered
	defer func() {
		close(release)
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	for name, read := range map[string]func() error{
		"link":                    func() error { _, err := f.ident.SignInLink(ctx, account.Token, link.Link.ID); return err },
		"issuer snapshot":         func() error { _, err := f.ident.SignInLinks(ctx, account.Token); return err },
		"candidate authorization": func() error { _, err := f.ident.SignInRequest(ctx, qr.Request.ID, qr.BrowserSecret); return err },
		"QR preview":              func() error { _, err := f.ident.PreviewQRSignIn(ctx, account.Token, qr.QRToken); return err },
	} {
		if err := read(); err != nil {
			t.Fatalf("%s waited for writer: %v", name, err)
		}
	}
}

func TestDeviceTerminalQRRequiresExplicitReplacement(t *testing.T) {
	for _, terminal := range []string{"denied", "cancelled"} {
		t.Run(terminal, func(t *testing.T) {
			f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
			account, _ := enroll(t, f, "Account")
			qr, _, err := f.ident.BeginQRSignIn(t.Context(), "", "", "", false, nil)
			if err != nil {
				t.Fatal(err)
			}
			if terminal == "denied" {
				_, err = f.ident.DenyQRSignIn(t.Context(), account.Token, qr.QRToken)
			} else {
				_, err = f.ident.CancelQRSignIn(t.Context(), qr.Request.ID, qr.BrowserSecret)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err = f.ident.BeginQRSignIn(t.Context(), qr.BrowserSecret, "", "", false, nil); !errors.Is(err, identity.ErrInvalidProof) {
				t.Fatalf("implicit terminal restart: %v", err)
			}
			f.clock.Advance(time.Second)
			replacement, _, err := f.ident.BeginQRSignIn(t.Context(), qr.BrowserSecret, "", "", true, nil)
			if err != nil {
				t.Fatal(err)
			}
			if replacement.Request.ID == qr.Request.ID || replacement.QRToken == qr.QRToken || !replacement.Request.ExpiresAt.After(qr.Request.ExpiresAt) {
				t.Fatal("explicit replacement did not start a new flow")
			}
		})
	}
}
