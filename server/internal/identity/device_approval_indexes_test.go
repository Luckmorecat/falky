package identity_test

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestDeviceLookupAndCleanupUseIndexes(t *testing.T) {
	f := newFixture(t, filepath.Join(t.TempDir(), "falky.db"))
	for _, tc := range []struct {
		name, query, search string
		args                []any
	}{
		{"qr browser all states", "SELECT id FROM account_signin_requests WHERE type='qr' AND browser_token_hash=? ORDER BY CASE WHEN state IN ('pending','approved') THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1", "SEARCH account_signin_requests USING INDEX account_signin_requests_qr_browser (browser_token_hash=?)", []any{make([]byte, 32)}},
		{"parent requests", "SELECT id FROM account_signin_requests WHERE link_id=?", "SEARCH account_signin_requests USING INDEX account_signin_requests_by_link (link_id=?)", []any{"link"}},
		{"purge requests", "DELETE FROM account_signin_requests WHERE id IN (SELECT id FROM account_signin_requests WHERE expires_at<=? AND state IN ('denied','cancelled') AND browser_token_hash IS NULL AND code IS NULL AND qr_token_hash IS NULL AND delivery_ciphertext IS NULL ORDER BY expires_at LIMIT ?)", "SEARCH account_signin_requests USING INDEX account_signin_requests_purge (qr_token_hash=? AND expires_at<?)", []any{f.clock.Now().Unix(), 128}},
		{"purge links", "DELETE FROM account_signin_links WHERE id IN (SELECT id FROM account_signin_links WHERE expires_at<=? AND token_hash IS NULL AND state IN ('revoked','consumed') AND NOT EXISTS(SELECT 1 FROM account_signin_requests r WHERE r.link_id=account_signin_links.id) LIMIT ?)", "SEARCH r USING COVERING INDEX account_signin_requests_by_link (link_id=?)", []any{f.clock.Now().Unix(), 128}},
		{"outstanding requests", "SELECT id FROM account_signin_requests WHERE expires_at<=? AND state!='consumed' AND (state IN ('pending','approved') OR browser_token_hash IS NOT NULL OR code IS NOT NULL OR qr_token_hash IS NOT NULL OR delivery_ciphertext IS NOT NULL)", "SEARCH account_signin_requests USING INDEX account_signin_requests_outstanding (expires_at<?)", []any{f.clock.Now().Unix()}},
		{"request secrets", "UPDATE account_signin_requests SET browser_token_hash=NULL,code=NULL,qr_token_hash=NULL,delivery_ciphertext=NULL WHERE expires_at<=? AND (state IN ('pending','approved') OR browser_token_hash IS NOT NULL OR code IS NOT NULL OR qr_token_hash IS NOT NULL OR delivery_ciphertext IS NOT NULL)", "SEARCH account_signin_requests USING INDEX account_signin_requests_outstanding (expires_at<?)", []any{f.clock.Now().Unix()}},
		{"active links", "SELECT id FROM account_signin_links WHERE expires_at<=? AND state IN ('open','approved')", "SEARCH account_signin_links USING INDEX account_signin_links_active_expiry (expires_at<?)", []any{f.clock.Now().Unix()}},
		{"link secrets", "UPDATE account_signin_links SET token_hash=NULL WHERE expires_at<=? AND token_hash IS NOT NULL", "SEARCH account_signin_links USING INDEX account_signin_links_secret_expiry (expires_at<?)", []any{f.clock.Now().Unix()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, err := f.db.Read().QueryContext(t.Context(), "EXPLAIN QUERY PLAN "+tc.query, tc.args...)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := rows.Close(); err != nil {
					t.Error(err)
				}
			}()
			var plan []string
			for rows.Next() {
				var id, parent, unused int
				var detail string
				if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
					t.Fatal(err)
				}
				plan = append(plan, detail)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			joined := strings.Join(plan, "\n")
			t.Log(joined)
			if !strings.Contains(joined, tc.search) {
				t.Fatalf("missing indexed search %q:\n%s", tc.search, joined)
			}
			if strings.Contains(joined, "SCAN r") || strings.Contains(joined, "SCAN account_signin_requests") {
				t.Fatalf("request table scan:\n%s", joined)
			}
		})
	}
}
