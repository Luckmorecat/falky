package admin_test

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kisshot/falky/server/internal/admin"
	"github.com/kisshot/falky/server/internal/platform"
)

func TestAdminErrorsHavePrivateCorrelatedDiagnostics(t *testing.T) {
	deps := newDeps(t)
	var logs bytes.Buffer
	deps.Logger = platform.NewLogger(&logs, 0)
	deps.SnapshotDir = filepath.Join(t.TempDir(), "private-directory")
	if err := os.WriteFile(deps.SnapshotDir, []byte("private-file"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := admin.Handler(deps)
	req := httptest.NewRequestWithContext(t.Context(), "POST", "/snapshots?secret=private-query", nil)
	req.Header.Set("X-Request-ID", "private-caller")
	req.Header.Set("X-Forwarded-For", "203.0.113.8")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	id := res.Header().Get("X-Request-ID")
	if res.Code != 500 || id == "" || id == "private-caller" {
		t.Fatalf("response=%d, id=%q", res.Code, id)
	}
	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &record); err != nil {
		t.Fatalf("logs=%s: %v", logs.String(), err)
	}
	if record["request_id"] != id || record["msg"] != "admin: snapshot" || record["error_kind"] == nil {
		t.Errorf("diagnostic=%v", record)
	}
	for _, private := range []string{"private-directory", "private-file", "private-query", "private-caller", "203.0.113.8"} {
		if strings.Contains(logs.String(), private) {
			t.Errorf("logs contain %q", private)
		}
	}
}
