package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/twitchtv/twirp"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/platform"
)

func logRecords(t *testing.T, logs string) []map[string]any {
	t.Helper()
	var records []map[string]any
	for line := range strings.SplitSeq(strings.TrimSpace(logs), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("invalid log JSON: %v", err)
		}
		records = append(records, record)
	}
	return records
}

func completion(t *testing.T, logs, id string) map[string]any {
	t.Helper()
	var found []map[string]any
	for _, r := range logRecords(t, logs) {
		if r["msg"] == "http request completed" && r["request_id"] == id {
			found = append(found, r)
		}
	}
	if len(found) != 1 {
		t.Fatalf("got %d completion records for %q in %s", len(found), id, logs)
	}
	return found[0]
}

func TestPublicRequestsHaveGeneratedCorrelationAndPrivateSummaries(t *testing.T) {
	p := startPublic(t, 10)
	b := p.browser(t)
	supplied := func(_ context.Context, r *http.Request) error {
		r.Header.Set("X-Request-ID", "caller-sensitive-id")
		r.Header.Set("X-Forwarded-For", "203.0.113.81")
		r.Header.Set("Authorization", "Bearer private-authorization")
		return nil
	}
	entered, err := b.EnterWithResponse(t.Context(), api.EnterRequest{Secret: p.secret, Name: "PrivateName"}, supplied)
	if err != nil {
		t.Fatal(err)
	}
	id := entered.HTTPResponse.Header.Get("X-Request-ID")
	if id == "" || id == "caller-sensitive-id" {
		t.Fatalf("request ID = %q", id)
	}
	room := p.createRoom(t, "PrivateRoomName")
	posted := attemptPost(t, b, room.ID, "private-key", "private-message")
	postID := posted.HTTPResponse.Header.Get("X-Request-ID")
	if postID == "" || postID == id {
		t.Fatalf("post request ID = %q", postID)
	}
	for _, want := range []struct {
		id, method, route string
		status            int
	}{
		{id, "POST", "/api/enter", 201}, {postID, "POST", "/api/rooms/{id}/messages", 201},
	} {
		record := completion(t, p.logs.String(), want.id)
		if record["method"] != want.method || record["route"] != want.route || record["status"] != float64(want.status) {
			t.Errorf("summary = %v", record)
		}
		if duration, ok := record["duration_ms"].(float64); !ok || duration < 0 {
			t.Errorf("duration = %v", record["duration_ms"])
		}
	}
	for _, private := range []string{p.secret, "PrivateName", "PrivateRoomName", "private-message", "private-key", "private-authorization", "caller-sensitive-id", "203.0.113.81"} {
		if strings.Contains(p.logs.String(), private) {
			t.Errorf("logs contain private data %q", private)
		}
	}
}

func TestRefusalSummariesValidateAndLimitClientIPs(t *testing.T) {
	p := startPublic(t, 1)
	for _, tc := range []struct {
		path, ip string
		status   int
		wantIP   string
	}{
		{"/api/me", "evil, 203.0.113.8", 401, "203.0.113.8"},
		{"/api/me", "2001:db8::1234", 401, "2001:db8::1234"},
		{"/api/me", "private-malformed-forwarded", 401, ""},
		{"/api/me", "203.0.113.8, private-malformed-forwarded", 401, ""},
		{"/api/me", "fe80::1%private-zone", 401, ""},
		{"/api/private-path?secret=private-query", "203.0.113.8", 404, ""},
		{"/api/live", "203.0.113.8", 403, "203.0.113.8"},
	} {
		req := httptest.NewRequestWithContext(t.Context(), "GET", tc.path, nil)
		req.Header.Set("X-Forwarded-For", tc.ip)
		// Exercise the same public handler used by the listener.
		req.RequestURI = ""
		req.URL.Scheme = "https"
		req.URL.Host = strings.TrimPrefix(p.srv.URL, "https://")
		res, err := p.srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != tc.status {
			t.Fatalf("status = %d, want %d", res.StatusCode, tc.status)
		}
		record := completion(t, p.logs.String(), res.Header.Get("X-Request-ID"))
		got, _ := record["client_ip"].(string)
		if got != tc.wantIP {
			t.Errorf("client IP=%q, want %q", got, tc.wantIP)
		}
	}
	b := p.browser(t)
	for _, status := range []int{403, 429} {
		res, err := b.EnterWithResponse(t.Context(), api.EnterRequest{Secret: "private-secret", Name: "PrivateName"}, forwardedFor("203.0.113.7"))
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode() != status {
			t.Fatalf("enter status=%d, want %d", res.StatusCode(), status)
		}
		record := completion(t, p.logs.String(), res.HTTPResponse.Header.Get("X-Request-ID"))
		if record["client_ip"] != "203.0.113.7" {
			t.Errorf("refusal IP=%v", record)
		}
	}
	for _, private := range []string{"private-path", "private-query", "private-malformed-forwarded", "private-zone", "private-secret", "PrivateName"} {
		if strings.Contains(p.logs.String(), private) {
			t.Errorf("logs contain %q", private)
		}
	}
}

func TestVoiceFailureLogsArePrivateAndCorrelated(t *testing.T) {
	p := startPublic(t, 10)
	room := p.createRoom(t, "PrivateRoom")
	b := p.browser(t)
	p.enter(t, b, "PrivateName")
	p.livekit.Fail(fmt.Errorf("upstream https://private-host/?token=private-token name=PrivateName: %w", syscall.ECONNREFUSED))
	res := joinVoice(t, b, room.ID)
	if res.StatusCode() != 503 {
		t.Fatalf("status=%d", res.StatusCode())
	}
	id := res.HTTPResponse.Header.Get("X-Request-ID")
	completion(t, p.logs.String(), id)
	found := false
	for _, record := range logRecords(t, p.logs.String()) {
		if record["msg"] == "voice join failed" {
			found = true
			if record["request_id"] != id || record["error_kind"] != "connection_refused" {
				t.Errorf("uncorrelated failure: %v", record)
			}
		}
	}
	if !found {
		t.Fatal("missing underlying voice failure")
	}
	for _, private := range []string{"private-host", "private-token", "PrivateName", "PrivateRoom"} {
		if strings.Contains(p.logs.String(), private) {
			t.Errorf("logs contain %q", private)
		}
	}
}

func TestWebSocketUpgradeAndLifetimeHavePrivateCorrelatedLogs(t *testing.T) {
	p := startPublic(t, 10)
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "PrivateName")
	ws, res, err := websocket.Dial(t.Context(), p.srv.URL+"/api/live?token=private-query", &websocket.DialOptions{
		HTTPClient: hc, HTTPHeader: http.Header{"Origin": {testOrigin}, "X-Request-ID": {"private-caller"}, "X-Forwarded-For": {"203.0.113.9"}},
	})
	if err != nil {
		if res != nil {
			_ = res.Body.Close()
		}
		t.Fatal(err)
	}
	defer func() { _ = ws.CloseNow() }()
	id := res.Header.Get("X-Request-ID")
	if id == "" || id == "private-caller" {
		t.Fatalf("upgrade ID=%q", id)
	}
	summary := completion(t, p.logs.String(), id)
	if summary["status"] != float64(101) || summary["route"] != "/api/live" {
		t.Fatalf("upgrade=%v", summary)
	}
	time.Sleep(20 * time.Millisecond)
	if err := ws.Close(websocket.StatusNormalClosure, "private-peer-reason"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		found := false
		for _, r := range logRecords(t, p.logs.String()) {
			if r["msg"] == "live connection closed" && r["request_id"] == id {
				found = true
				if r["connection_id"] != id || r["close_code"] != float64(1000) || r["reason"] != "peer_closed" {
					t.Errorf("close=%v", r)
				}
				if r["lifetime_ms"].(float64) < 20 {
					t.Errorf("lifetime=%v", r)
				}
			}
		}
		if found {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no correlated close log")
		}
		time.Sleep(time.Millisecond)
	}
	opened := 0
	for _, r := range logRecords(t, p.logs.String()) {
		if r["msg"] == "live connection opened" && r["request_id"] == id {
			opened++
		}
	}
	if opened != 1 {
		t.Errorf("open logs=%d", opened)
	}
	for _, private := range []string{"PrivateName", "private-query", "private-caller", "private-peer-reason", "203.0.113.9"} {
		if strings.Contains(p.logs.String(), private) {
			t.Errorf("logs contain %q", private)
		}
	}
}

func TestInternalResponsesCarryIDsWhileSuccessfulProbesStayQuiet(t *testing.T) {
	p := startPublic(t, 10)
	for _, path := range []string{"/health/live", "/health/ready", "/metrics", "/private-path?secret=private-query"} {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, p.internal.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := p.internal.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.Header.Get("X-Request-ID") == "" {
			t.Errorf("missing ID for %s", path)
		}
	}
	if p.logs.String() != "" {
		t.Errorf("internal probes logged: %s", p.logs.String())
	}
}

func TestRequestErrorsKeepIDsAndAvoidRawErrorAndRouteData(t *testing.T) {
	p := startPublic(t, 10)
	req := httptest.NewRequestWithContext(t.Context(), "GET", "/api/me?token=private-query", nil)
	req.Header.Set("Cookie", "falky_visitor=private-cookie")
	req.Header.Set("X-Forwarded-For", "203.0.113.80")
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	res := httptest.NewRecorder()
	p.srv.Config.Handler.ServeHTTP(res, req.WithContext(ctx))
	if res.Code != 500 {
		t.Fatalf("status=%d, body=%s", res.Code, res.Body)
	}
	id := res.Header().Get("X-Request-ID")
	if id == "" {
		t.Fatal("missing failure ID")
	}
	completion(t, p.logs.String(), id)
	failed := 0
	for _, record := range logRecords(t, p.logs.String()) {
		if record["msg"] == "request failed" {
			failed++
			if record["request_id"] != id || record["error_kind"] != "canceled" {
				t.Errorf("failure=%v", record)
			}
		}
	}
	if failed != 1 {
		t.Errorf("failure count=%d, logs=%s", failed, p.logs.String())
	}
	for _, private := range []string{"private-query", "private-cookie", "203.0.113.80"} {
		if strings.Contains(p.logs.String(), private) {
			t.Errorf("logs contain %q", private)
		}
	}
}

func TestMessageErrorsAndMalformedRoutesHaveSafeSummaries(t *testing.T) {
	p := startPublicLimited(t, 10, 1)
	room := p.createRoom(t, "PrivateRoom")
	b := p.browser(t)
	p.enter(t, b, "PrivateName")
	for _, tc := range []struct {
		key, body string
		status    int
	}{
		{"private-key", "", 400}, {"private-key", "private-message", 201}, {"private-other", "private-other-message", 429},
	} {
		res, err := b.PostMessageWithResponse(t.Context(), room.ID, api.PostMessageRequest{RequestKey: tc.key, Body: tc.body}, forwardedFor("2001:db8::55"))
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode() != tc.status {
			t.Fatalf("status=%d want=%d", res.StatusCode(), tc.status)
		}
		record := completion(t, p.logs.String(), res.HTTPResponse.Header.Get("X-Request-ID"))
		if record["route"] != "/api/rooms/{id}/messages" || record["status"] != float64(tc.status) {
			t.Errorf("summary=%v", record)
		}
		if tc.status == 429 {
			if record["client_ip"] != "2001:db8::55" {
				t.Errorf("missing IP=%v", record)
			}
		} else if record["client_ip"] != nil {
			t.Errorf("unexpected IP=%v", record)
		}
	}
	for _, path := range []string{"/private-path?secret=private-query", "/api/private-path/../other", "/api//private-path", "/api/rooms/private-room/messages?before=private-query"} {
		req := httptest.NewRequestWithContext(t.Context(), "GET", path, nil)
		res := httptest.NewRecorder()
		p.srv.Config.Handler.ServeHTTP(res, req)
		record := completion(t, p.logs.String(), res.Header().Get("X-Request-ID"))
		if record["route"] != "unmatched" && record["route"] != "/api/rooms/{id}/messages" {
			t.Errorf("unsafe route=%v", record)
		}
	}
	if strings.Contains(p.logs.String(), "private-") || strings.Contains(p.logs.String(), "Private") {
		t.Errorf("private logs: %s", p.logs.String())
	}
}

func TestRevokedWebSocketLogsSafeCloseCode(t *testing.T) {
	p := startPublic(t, 10)
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "PrivateName")
	ws, res, err := websocket.Dial(t.Context(), p.srv.URL+"/api/live", &websocket.DialOptions{HTTPClient: hc, HTTPHeader: http.Header{"Origin": {testOrigin}}})
	if err != nil {
		if res != nil {
			_ = res.Body.Close()
		}
		t.Fatal(err)
	}
	defer func() { _ = ws.CloseNow() }()
	id := res.Header.Get("X-Request-ID")
	p.events.AccessRevoked()
	nextEvent(t, ws)
	_, _, err = ws.Read(t.Context())
	if websocket.CloseStatus(err) != 4001 {
		t.Fatalf("close=%v", err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		found := false
		for _, record := range logRecords(t, p.logs.String()) {
			if record["msg"] == "live connection closed" && record["request_id"] == id {
				found = true
				if record["reason"] != "access_revoked" || record["close_code"] != float64(4001) {
					t.Errorf("close=%v", record)
				}
			}
		}
		if found {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("missing revoked close log")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestMalformedWebSocketUpgradeKeepsCorrelationAndErrorPrivacy(t *testing.T) {
	p := startPublic(t, 10)
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "PrivateName")
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, p.srv.URL+"/api/live?token=private-query", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "private-protocol-token")
	req.Header.Set("Sec-WebSocket-Key", "private-key")
	req.Header.Set("X-Forwarded-For", "203.0.113.77")
	res, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("status=%d", res.StatusCode)
	}
	id := res.Header.Get("X-Request-ID")
	completion(t, p.logs.String(), id)
	refused := 0
	for _, record := range logRecords(t, p.logs.String()) {
		if record["msg"] == "live connection refused" {
			refused++
			if record["request_id"] != id {
				t.Errorf("uncorrelated refusal=%v", record)
			}
		}
	}
	if refused != 1 {
		t.Fatalf("refusal logs=%d", refused)
	}
	for _, private := range []string{"private-", "PrivateName", "203.0.113.77"} {
		if strings.Contains(p.logs.String(), private) {
			t.Errorf("logs contain %q", private)
		}
	}
}

func TestConfiguredMinimumLevelFiltersRequestsButKeepsFailureCorrelation(t *testing.T) {
	var logs bytes.Buffer
	logger := platform.NewLogger(&logs, slog.LevelWarn)
	health := platform.NewHealth(logger)
	health.Optional("livekit", func(context.Context) error { return twirp.NewError(twirp.Unauthenticated, "private-token") })
	handlers := New(Deps{Logger: logger, Health: health, Metrics: platform.NewMetrics().Handler()})
	req := httptest.NewRequestWithContext(t.Context(), "GET", "/private-path", nil)
	res := httptest.NewRecorder()
	handlers.Public.ServeHTTP(res, req)
	if logs.Len() != 0 || res.Header().Get("X-Request-ID") == "" {
		t.Errorf("level filtering=%s, header=%v", logs.String(), res.Header())
	}
	req = httptest.NewRequestWithContext(t.Context(), "GET", "/health/ready", nil)
	res = httptest.NewRecorder()
	handlers.Internal.ServeHTTP(res, req)
	records := logRecords(t, logs.String())
	if len(records) != 1 {
		t.Fatalf("warning logs=%v", records)
	}
	if records[0]["level"] != "WARN" || records[0]["error_kind"] != "livekit_unauthenticated" || records[0]["request_id"] != res.Header().Get("X-Request-ID") {
		t.Errorf("warning=%v", records[0])
	}
	if strings.Contains(logs.String(), "private-") {
		t.Errorf("private failure=%s", logs.String())
	}
}
