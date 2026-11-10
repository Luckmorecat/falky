package httpapi

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/realtime"
)

func decodeAs[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return v
}

func cookieNamed(cookies []*http.Cookie, name string) *http.Cookie {
	for _, c := range cookies {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestTheAccessPasswordSetsAPassCookie(t *testing.T) {
	p := startPublic(t, 100)
	_, c := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, c, http.MethodGet, "/api/access", nil, "", http.StatusOK)
	if got := decodeAs[api.Access](t, raw); !got.PasswordSet || got.Passed || got.GuestName != "" {
		t.Fatalf("access before the password = %+v", got)
	}
	accountRequest(t, p, c, http.MethodPost, "/api/access", map[string]any{"password": testAccessPassword}, "", http.StatusForbidden)
	raw, _ = accountRequest(t, p, c, http.MethodPost, "/api/access", map[string]any{"password": "wrong"}, testOrigin, http.StatusForbidden)
	wantError(t, "a wrong access password", http.StatusForbidden, raw, http.StatusForbidden, "invalid_access_password")
	raw, res := accountRequest(t, p, c, http.MethodPost, "/api/access", map[string]any{"password": testAccessPassword}, testOrigin, http.StatusOK)
	if got := decodeAs[api.Access](t, raw); !got.Passed {
		t.Fatalf("access after the password = %+v", got)
	}
	cookie := cookieNamed(res.Cookies, accessCookie)
	if cookie == nil || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/api" {
		t.Fatalf("access cookie = %+v", cookie)
	}
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("an access response can be cached")
	}
	raw, _ = accountRequest(t, p, c, http.MethodGet, "/api/access", nil, "", http.StatusOK)
	if got := decodeAs[api.Access](t, raw); !got.Passed {
		t.Fatalf("access is not remembered: %+v", got)
	}
}

func TestAccessPasswordAttemptsAreLimitedPerClient(t *testing.T) {
	p := startPublic(t, 2)
	b := p.browser(t)
	from := forwardedFor("203.0.113.7")
	for i := range 3 {
		res, err := b.PassAccessWithResponse(t.Context(), api.PassAccessJSONRequestBody{Password: "wrong"}, from)
		if err != nil {
			t.Fatal(err)
		}
		want, code := http.StatusForbidden, "invalid_access_password"
		if i == 2 {
			want, code = http.StatusTooManyRequests, "rate_limited"
		}
		wantError(t, fmt.Sprintf("attempt %d", i+1), res.StatusCode(), res.Body, want, code)
	}
	res, err := b.PassAccessWithResponse(t.Context(), api.PassAccessJSONRequestBody{Password: testAccessPassword}, forwardedFor("203.0.113.8"))
	if err != nil || res.StatusCode() != http.StatusOK {
		t.Fatalf("another client = %v, %v", res.StatusCode(), err)
	}
}

func TestRegisteringNeedsThePassAndValidDetails(t *testing.T) {
	p := startPublic(t, 100)
	p.enter(t, p.browser(t), "Ann")
	_, c := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, c, http.MethodPost, "/api/accounts/register", map[string]any{"login": "!", "password": "", "name": ""}, testOrigin, http.StatusForbidden)
	wantError(t, "register without a pass", http.StatusForbidden, raw, http.StatusForbidden, "access_required")
	accountRequest(t, p, c, http.MethodPost, "/api/access", map[string]any{"password": testAccessPassword}, testOrigin, http.StatusOK)
	for _, tc := range []struct {
		login, password, name string
		status                int
		code                  string
	}{
		{"x", testPassword, "Bob", 400, "invalid_login"},
		{"bob", "short", "Bob", 400, "invalid_password"},
		{"bob", testPassword, " ", 400, "invalid_name"},
		{"ANN", testPassword, "Bob", 409, "login_taken"},
		{"bob", testPassword, "ann", 409, "name_taken"},
	} {
		raw, _ := accountRequest(t, p, c, http.MethodPost, "/api/accounts/register", map[string]any{"login": tc.login, "password": tc.password, "name": tc.name}, testOrigin, tc.status)
		wantError(t, "register "+tc.code, tc.status, raw, tc.status, tc.code)
	}
	raw, res := accountRequest(t, p, c, http.MethodPost, "/api/accounts/register", map[string]any{"login": "bob", "password": testPassword, "name": "Bob"}, testOrigin, http.StatusOK)
	enrolled := decodeAs[api.AccountEnrollment](t, raw)
	if enrolled.Session.Kind != api.AccountSessionKindAccount || enrolled.Session.Visitor.Name != "Bob" {
		t.Fatalf("enrollment = %+v", enrolled)
	}
	session := cookieNamed(res.Cookies, cookieName)
	if session == nil || !session.HttpOnly || !session.Secure || session.SameSite != http.SameSiteStrictMode || session.Path != "/api" {
		t.Fatalf("session cookie = %+v", session)
	}
	raw, _ = accountRequest(t, p, c, http.MethodGet, "/api/accounts/session", nil, "", http.StatusOK)
	if got := decodeAs[api.AccountSession](t, raw); got.Visitor.Id != enrolled.Session.Visitor.Id {
		t.Fatalf("session = %+v", got)
	}
}

func TestSigningInSaysNothingAboutWhichPartIsWrong(t *testing.T) {
	p := startPublic(t, 3)
	p.enter(t, p.browser(t), "Ann")
	_, c := p.browserWithHTTP(t)
	raw, _ := accountRequest(t, p, c, http.MethodPost, "/api/accounts/login", map[string]any{"login": "ann", "password": testPassword}, testOrigin, http.StatusForbidden)
	wantError(t, "login without a pass", http.StatusForbidden, raw, http.StatusForbidden, "access_required")
	accountRequest(t, p, c, http.MethodPost, "/api/access", map[string]any{"password": testAccessPassword}, testOrigin, http.StatusOK)
	for _, body := range []map[string]any{{"login": "ann", "password": "wrong password"}, {"login": "nobody", "password": testPassword}} {
		raw, _ := accountRequest(t, p, c, http.MethodPost, "/api/accounts/login", body, testOrigin, http.StatusUnauthorized)
		wantError(t, "login", http.StatusUnauthorized, raw, http.StatusUnauthorized, "invalid_credentials")
	}
	accountRequest(t, p, c, http.MethodPost, "/api/accounts/login", map[string]any{"login": "Ann", "password": testPassword}, testOrigin, http.StatusOK)
	// The limit per login holds whatever address the attempts come from.
	raw, _ = accountRequest(t, p, c, http.MethodPost, "/api/accounts/login", map[string]any{"login": "ann", "password": testPassword}, testOrigin, http.StatusTooManyRequests)
	wantError(t, "login over the limit", http.StatusTooManyRequests, raw, http.StatusTooManyRequests, "rate_limited")
}

func TestChangingThePasswordKeepsThisSessionAndEndsTheOthers(t *testing.T) {
	p := startPublic(t, 100)
	_, here := p.browserWithHTTP(t)
	registerAccount(t, p, here, "Ann")
	_, there := loginAccountBrowser(t, p, "ann")
	elsewhere := p.connectLive(t, there)
	raw, _ := accountRequest(t, p, here, http.MethodPut, "/api/accounts/password", map[string]any{"currentPassword": "wrong password", "newPassword": "a new password"}, testOrigin, http.StatusForbidden)
	wantError(t, "a wrong current password", http.StatusForbidden, raw, http.StatusForbidden, "invalid_credentials")
	raw, _ = accountRequest(t, p, here, http.MethodPut, "/api/accounts/password", map[string]any{"currentPassword": testPassword, "newPassword": "short"}, testOrigin, http.StatusBadRequest)
	wantError(t, "a short new password", http.StatusBadRequest, raw, http.StatusBadRequest, "invalid_password")
	accountRequest(t, p, here, http.MethodPut, "/api/accounts/password", map[string]any{"currentPassword": testPassword, "newPassword": "a new password"}, testOrigin, http.StatusOK)
	readClosed(t, elsewhere, realtime.StatusRevoked)
	accountRequest(t, p, here, http.MethodGet, "/api/accounts/session", nil, "", http.StatusOK)
	accountRequest(t, p, there, http.MethodGet, "/api/accounts/session", nil, "", http.StatusUnauthorized)
}

func TestRecoveringSetsANewPasswordAndSignsIn(t *testing.T) {
	p := startPublic(t, 100)
	_, old := p.browserWithHTTP(t)
	account := registerAccount(t, p, old, "Ann")
	code := p.recoveryCode(t, "ann")
	_, c := p.browserWithHTTP(t)
	accountRequest(t, p, c, http.MethodPost, "/api/access", map[string]any{"password": testAccessPassword}, testOrigin, http.StatusOK)
	raw, _ := accountRequest(t, p, c, http.MethodPost, "/api/accounts/recovery", map[string]any{"account": "ann", "proof": "not the code", "password": "a new password"}, testOrigin, http.StatusForbidden)
	wantError(t, "a wrong code", http.StatusForbidden, raw, http.StatusForbidden, "invalid_proof")
	raw, _ = accountRequest(t, p, c, http.MethodPost, "/api/accounts/recovery", map[string]any{"account": "ann", "proof": code, "password": "a new password"}, testOrigin, http.StatusOK)
	recovered := decodeAs[api.AccountEnrollment](t, raw)
	if recovered.Session.Visitor.Id != account.Session.Visitor.ID {
		t.Fatalf("recovery = %+v", recovered)
	}
	accountRequest(t, p, old, http.MethodGet, "/api/accounts/session", nil, "", http.StatusUnauthorized)
	accountRequest(t, p, c, http.MethodGet, "/api/accounts/session", nil, "", http.StatusOK)
}

func TestALegacyGuestRegistersWithoutThePassAndKeepsItsHistory(t *testing.T) {
	p := startPublic(t, 100)
	room := p.createRoom(t, "Lounge")
	author := p.browser(t)
	p.enter(t, author, "Ann")
	id, token := "01JBX6Z8Q3M5W2K7R9T4V1C0DE", "legacy-guest-cookie"
	sum := sha256.Sum256([]byte(token))
	now := p.clock.Now().Unix()
	if err := p.db.Write(t.Context(), func(tx *sql.Tx) error {
		for _, stmt := range []struct {
			query string
			args  []any
		}{
			{"INSERT INTO access (id, link_secret, generation, rotated_at) VALUES (1, 'old link', 1, '2026-11-01')", nil},
			{"INSERT INTO identities (id, name, created_at) VALUES (?, 'Bob', '2026-11-01')", []any{id}},
			{"INSERT INTO sessions (id, token_hash, identity_id, generation, created_at, expires_at) VALUES ('guest', ?, ?, 1, ?, ?)", []any{sum[:], id, now, now + 3600}},
			{"INSERT INTO messages (id, room_id, author_id, author_name, body, request_key, created_at) VALUES ('01JBX6Z8Q3M5W2K7R9T4V1C0DF', ?, ?, 'Bob', 'from before', 'k', '2026-11-01T00:00:00.000Z')", []any{room.ID, id}},
		} {
			if _, err := tx.ExecContext(t.Context(), stmt.query, stmt.args...); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := p.identity.InitializeColours(t.Context()); err != nil {
		t.Fatal(err)
	}
	_, c := p.browserWithHTTP(t)
	c.Jar.SetCookies(mustURL(t, p.srv.URL+"/api"), []*http.Cookie{{Name: cookieName, Value: token, Path: "/api"}})
	accountRequest(t, p, c, http.MethodGet, "/api/me", nil, "", http.StatusUnauthorized)
	raw, _ := accountRequest(t, p, c, http.MethodGet, "/api/access", nil, "", http.StatusOK)
	if got := decodeAs[api.Access](t, raw); got.Passed || got.GuestName != "Bob" {
		t.Fatalf("access of a legacy guest = %+v", got)
	}
	raw, _ = accountRequest(t, p, c, http.MethodPost, "/api/accounts/register", map[string]any{"login": "bob", "password": testPassword, "name": "Bob"}, testOrigin, http.StatusOK)
	if got := decodeAs[api.AccountEnrollment](t, raw); got.Session.Visitor.Id != id {
		t.Fatalf("the account did not keep the guest's identity: %+v", got.Session.Visitor)
	}
	raw, _ = accountRequest(t, p, c, http.MethodGet, "/api/rooms/"+room.ID+"/messages", nil, "", http.StatusOK)
	if got := decodeAs[api.MessageList](t, raw); len(got.Messages) != 1 || got.Messages[0].AuthorId != id {
		t.Fatalf("history = %+v", got)
	}
}

func TestAccountsCreateAndRenameRoomsEveryoneSees(t *testing.T) {
	p := startPublic(t, 100)
	ann, annHTTP := p.browserWithHTTP(t)
	p.enter(t, ann, "Ann")
	watcher := p.connectLive(t, annHTTP)
	bob := p.browser(t)
	p.enter(t, bob, "Bob")

	created, err := bob.CreateRoomWithResponse(t.Context(), api.RoomNameRequest{Name: "  Lounge "})
	if err != nil || created.StatusCode() != http.StatusCreated || created.JSON201 == nil || created.JSON201.Name != "Lounge" || len(created.JSON201.Occupancy) != 0 {
		t.Fatalf("CreateRoom = %v %s, %v", created.StatusCode(), created.Body, err)
	}
	if event := nextEvent(t, watcher); event.Type != api.EventTypeRoomChanged {
		t.Fatalf("event after creating = %+v", event)
	}
	for name, code := range map[string]string{"lounge": "room_name_taken", "": "invalid_name"} {
		res, err := ann.CreateRoomWithResponse(t.Context(), api.RoomNameRequest{Name: name})
		if err != nil {
			t.Fatal(err)
		}
		want := http.StatusConflict
		if code == "invalid_name" {
			want = http.StatusBadRequest
		}
		wantError(t, "CreateRoom("+name+")", res.StatusCode(), res.Body, want, code)
	}
	games, err := ann.CreateRoomWithResponse(t.Context(), api.RoomNameRequest{Name: "Games"})
	if err != nil || games.JSON201 == nil {
		t.Fatalf("CreateRoom(Games) = %v, %v", games, err)
	}
	nextEvent(t, watcher)

	renamed, err := ann.RenameRoomWithResponse(t.Context(), created.JSON201.Id, api.RoomNameRequest{Name: "Living room"})
	if err != nil || renamed.StatusCode() != http.StatusOK || renamed.JSON200 == nil || renamed.JSON200.Name != "Living room" {
		t.Fatalf("RenameRoom = %v %s, %v", renamed.StatusCode(), renamed.Body, err)
	}
	if event := nextEvent(t, watcher); event.Type != api.EventTypeRoomChanged {
		t.Fatalf("event after renaming = %+v", event)
	}
	res, err := ann.RenameRoomWithResponse(t.Context(), created.JSON201.Id, api.RoomNameRequest{Name: "GAMES"})
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, "renaming to another room's name", res.StatusCode(), res.Body, http.StatusConflict, "room_name_taken")
	missing, err := ann.RenameRoomWithResponse(t.Context(), "01JBX6ZZZZZZZZZZZZZZZZZZZZ", api.RoomNameRequest{Name: "Nowhere"})
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, "renaming an unknown room", missing.StatusCode(), missing.Body, http.StatusNotFound, "room_not_found")

	anonymous, err := p.browser(t).CreateRoomWithResponse(t.Context(), api.RoomNameRequest{Name: "Sneaky"})
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, "creating without a session", anonymous.StatusCode(), anonymous.Body, http.StatusUnauthorized, "visitor_required")
}

func TestRoomsStopAtTheLimit(t *testing.T) {
	p := startPublic(t, 100)
	for i := range maxRooms - 1 {
		p.createRoom(t, fmt.Sprintf("Room %d", i))
	}
	b := p.browser(t)
	p.enter(t, b, "Ann")
	last, err := b.CreateRoomWithResponse(t.Context(), api.RoomNameRequest{Name: "The last one"})
	if err != nil || last.StatusCode() != http.StatusCreated {
		t.Fatalf("the last room = %v, %v", last.StatusCode(), err)
	}
	over, err := b.CreateRoomWithResponse(t.Context(), api.RoomNameRequest{Name: "One too many"})
	if err != nil {
		t.Fatal(err)
	}
	wantError(t, "a room over the limit", over.StatusCode(), over.Body, http.StatusConflict, "room_limit")
}
