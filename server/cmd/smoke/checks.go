package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/oklog/ulid/v2"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/realtime"
)

// The server's limit on account requests, per client address: a burst of
// enterBurst attempts, then one more each enterInterval.
const (
	enterBurst    = 20
	enterInterval = 3 * time.Second
)

// password is the password this run's accounts register with.
const password = "smoke test password"

// occupancyWait bounds how long a voice change may take to reach live
// updates. LiveKit's webhook brings it in milliseconds; without the webhook
// it would wait for the server's refresh, every 30 seconds.
const occupancyWait = 3 * time.Second

// revokeWait bounds how long disabling an account may take to end live
// updates and voice, counted from starting the command.
const revokeWait = 2 * time.Second

func (s *smoke) passwordSet(ctx context.Context) error {
	s.password = "smoke access " + s.suffix
	out, err := s.dockerWithInput(ctx, s.password+"\n", "exec", "-T", "falky", "/falky", "password", "set")
	if err != nil {
		return err
	}
	if strings.Contains(out, s.password) {
		return errors.New("falky password set printed the password")
	}
	return nil
}

func (s *smoke) roomCreate(ctx context.Context) error {
	id, err := s.falky(ctx, "room", "create", "Smoke "+s.suffix)
	if err != nil {
		return err
	}
	if _, err := ulid.ParseStrict(id); err != nil {
		return fmt.Errorf("room ID %q: %w", id, err)
	}
	s.roomID = id
	return nil
}

func (s *smoke) enter(ctx context.Context) error {
	ann, err := s.enterAs(ctx, "Ann "+s.suffix)
	if err != nil {
		return err
	}
	if c := ann.cookie; !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode {
		return fmt.Errorf("cookie %s: want HttpOnly, Secure and SameSite=Strict", c)
	}
	res, err := ann.api.GetMeWithResponse(ctx)
	if err != nil {
		return err
	}
	if res.JSON200 == nil {
		return wantError(res.HTTPResponse, res.Body, http.StatusOK, "")
	}
	if me := *res.JSON200; me.Id != ann.Id || me.Name != ann.Name || me.NameTaken {
		return fmt.Errorf("GET /api/me = %+v, want %+v", me, ann.Visitor)
	}
	s.ann = ann
	return nil
}

func (s *smoke) foreignOrigin(ctx context.Context) error {
	l, err := s.dialLive(ctx, s.ann, "https://elsewhere.example")
	return wantRefused(l, err, http.StatusForbidden, "origin_forbidden")
}

func (s *smoke) post(ctx context.Context) error {
	l, err := s.dialLive(ctx, s.ann, s.origin)
	if err != nil {
		return err
	}
	s.annLive = l
	return s.postAndReceive(ctx, s.ann, l, "smoke-"+s.suffix)
}

// postAndReceive posts a message as v under requestKey and fails unless l
// receives it as message.created within a second.
func (s *smoke) postAndReceive(ctx context.Context, v *visitor, l *liveConn, requestKey string) error {
	start := time.Now()
	res, err := v.api.PostMessageWithResponse(ctx, s.roomID, api.PostMessageJSONRequestBody{
		RequestKey: requestKey,
		Body:       "Hello from the smoke test",
	})
	if err != nil {
		return err
	}
	if res.JSON201 == nil {
		return wantError(res.HTTPResponse, res.Body, http.StatusCreated, "")
	}
	posted := *res.JSON201
	e, err := l.next(ctx, time.Second-time.Since(start), "message.created", func(e api.Event) bool {
		m, err := e.Payload.AsMessage()
		return e.Type == api.EventTypeMessageCreated && err == nil && m.Id == posted.Id
	})
	if err != nil {
		return err
	}
	if m, _ := e.Payload.AsMessage(); e.RoomId != s.roomID || m.Body != posted.Body || m.AuthorName != v.Name {
		return fmt.Errorf("message.created = %+v in room %s, want %+v in room %s", m, e.RoomId, posted, s.roomID)
	}
	s.logf("message.created %s after posting", time.Since(start).Round(time.Millisecond))
	return nil
}

func (s *smoke) renameRoom(ctx context.Context) error {
	name := "Smoke " + s.suffix + " renamed"
	start := time.Now()
	if _, err := s.falky(ctx, "room", "rename", s.roomID, name); err != nil {
		return err
	}
	_, err := s.annLive.next(ctx, time.Second-time.Since(start), "room.changed", func(e api.Event) bool {
		c, err := e.Payload.AsRoomChange()
		return e.Type == api.EventTypeRoomChanged && err == nil && c.Id == s.roomID && c.Name == name
	})
	return err
}

func (s *smoke) joinVoice(ctx context.Context) error {
	start := time.Now()
	if err := s.joinAnn(ctx); err != nil {
		return err
	}
	if err := s.sentWebhook(ctx, start, "participant_joined"); err != nil {
		return err
	}
	return s.wantOccupancy(ctx, s.ann, s.ann)
}

// sentWebhook fails unless LiveKit's log since start shows it sent the
// server a webhook of event for the room and the server applied it (204).
// Together with the occupancy change arriving well within the server's
// 30-second refresh, it shows the webhook carried the change.
func (s *smoke) sentWebhook(ctx context.Context, start time.Time, event string) error {
	logs, err := s.docker(ctx, "logs", "--no-log-prefix", "--since", start.Add(-time.Second).UTC().Format(time.RFC3339Nano), "livekit")
	if err != nil {
		return err
	}
	for line := range strings.Lines(logs) {
		var l struct {
			Msg, Event, Room string
			StatusCode       int
		}
		if json.Unmarshal([]byte(line), &l) == nil && l.Msg == "sent webhook" && l.Event == event &&
			l.Room == s.roomID && l.StatusCode == http.StatusNoContent {
			return nil
		}
	}
	return fmt.Errorf("LiveKit's log shows no %s webhook for the room that the server applied", event)
}

// joinAnn asks the server for Ann's voice credentials, connects with them and
// waits for the occupancy.changed that lists her.
func (s *smoke) joinAnn(ctx context.Context) error {
	res, err := s.ann.api.JoinVoiceWithBodyWithResponse(ctx, s.roomID, "application/json", nil)
	if err != nil {
		return err
	}
	if res.JSON200 == nil {
		return wantError(res.HTTPResponse, res.Body, http.StatusOK, "")
	}
	s.creds = res.JSON200
	start := time.Now()
	if s.voice, err = join(s.creds); err != nil {
		return err
	}
	if _, err := s.annLive.next(ctx, occupancyWait, "occupancy.changed listing Ann", occupancyIs(s.roomID, s.ann.Id)); err != nil {
		return err
	}
	s.logf("occupancy.changed %s after starting to connect to LiveKit", time.Since(start).Round(time.Millisecond))
	return nil
}

// wantOccupancy fails unless GET /api/rooms, asked as reader, lists exactly
// the visitors want in the room's voice, by name.
func (s *smoke) wantOccupancy(ctx context.Context, reader *visitor, want ...*visitor) error {
	res, err := reader.api.ListRoomsWithResponse(ctx)
	if err != nil {
		return err
	}
	if res.JSON200 == nil {
		return wantError(res.HTTPResponse, res.Body, http.StatusOK, "")
	}
	for _, r := range res.JSON200.Rooms {
		if r.Id != s.roomID {
			continue
		}
		ok := len(r.Occupancy) == len(want)
		for i := 0; ok && i < len(want); i++ {
			ok = r.Occupancy[i].VisitorId == want[i].Id && r.Occupancy[i].Name == want[i].Name
		}
		if !ok {
			return fmt.Errorf("GET /api/rooms lists %+v in the room's voice, want %d visitors", r.Occupancy, len(want))
		}
		return nil
	}
	return fmt.Errorf("GET /api/rooms does not list room %s", s.roomID)
}

func (s *smoke) replace(ctx context.Context) error {
	first := s.voice
	second, err := join(s.creds)
	if err != nil {
		return err
	}
	s.voice = second
	if _, err := within(ctx, occupancyWait, first.disconnected, "the first connection ending"); err != nil {
		return err
	}
	if reason := first.room.DisconnectReason(); reason != livekit.DisconnectReason_DUPLICATE_IDENTITY {
		return fmt.Errorf("the first connection ended with %v, want %v", reason, livekit.DisconnectReason_DUPLICATE_IDENTITY)
	}
	if state := second.room.ConnectionState(); state != lksdk.ConnectionStateConnected {
		return fmt.Errorf("the second connection is %s, want connected", state)
	}
	// LiveKit reports the first connection leaving and the second joining.
	s.annLive.drain(time.Second)
	return s.wantOccupancy(ctx, s.ann, s.ann)
}

func (s *smoke) leaveVoice(ctx context.Context) error {
	start := time.Now()
	s.voice.leave()
	s.voice = nil
	if _, err := s.annLive.next(ctx, occupancyWait, "occupancy.changed with no one", occupancyIs(s.roomID)); err != nil {
		return err
	}
	s.logf("occupancy.changed %s after leaving", time.Since(start).Round(time.Millisecond))
	if err := s.sentWebhook(ctx, start, "participant_left"); err != nil {
		return err
	}
	return s.wantOccupancy(ctx, s.ann)
}

func (s *smoke) nameConflict(ctx context.Context) error {
	var se *statusError
	if _, err := s.enterAs(ctx, strings.ToUpper("Ann "+s.suffix)); !errors.As(err, &se) || se.status != http.StatusConflict {
		return fmt.Errorf("registering Ann's name and login again: %w, want 409", err)
	}
	if _, err := s.register(ctx, "xan-"+s.suffix, "ANN "+s.suffix); !errors.As(err, &se) || se.code != "name_taken" {
		return fmt.Errorf("registering Ann's name under another login: %w, want 409 name_taken", err)
	}
	if _, err := s.register(ctx, s.ann.login, "Xan "+s.suffix); !errors.As(err, &se) || se.code != "login_taken" {
		return fmt.Errorf("registering Ann's login under another name: %w, want 409 login_taken", err)
	}
	return nil
}

func (s *smoke) disable(ctx context.Context) error {
	if err := s.joinAnn(ctx); err != nil {
		return err
	}
	start := time.Now()
	if _, err := s.falky(ctx, "account", "disable", s.ann.login); err != nil {
		return err
	}
	status, err := s.annLive.closed(ctx, revokeWait-time.Since(start))
	if err != nil {
		return err
	}
	if status != realtime.StatusRevoked {
		return fmt.Errorf("live updates closed with %d, want %d", status, realtime.StatusRevoked)
	}
	closed := time.Since(start)
	s.annLive = nil
	if _, err := within(ctx, revokeWait-time.Since(start), s.voice.disconnected, "voice ending"); err != nil {
		return err
	}
	s.logf("live updates closed with %d after %s, voice ended (%v) after %s",
		status, closed.Round(time.Millisecond), s.voice.room.DisconnectReason(), time.Since(start).Round(time.Millisecond))
	s.voice = nil

	me, err := s.ann.api.GetMeWithResponse(ctx)
	if err != nil {
		return err
	}
	if err := wantError(me.HTTPResponse, me.Body, http.StatusUnauthorized, "visitor_required"); err != nil {
		return err
	}
	l, err := s.dialLive(ctx, s.ann, s.origin)
	if err := wantRefused(l, err, http.StatusUnauthorized, "visitor_required"); err != nil {
		return fmt.Errorf("with the old cookie: %w", err)
	}
	var se *statusError
	if _, err := s.signIn(ctx, s.ann.login); !errors.As(err, &se) || se.code != "account_disabled" {
		return fmt.Errorf("signing in while disabled: %w, want 403 account_disabled", err)
	}
	if s.nia, err = s.enterAs(ctx, "Nia "+s.suffix); err != nil {
		return err
	}
	return s.wantOccupancy(ctx, s.nia)
}

// idleWait is how long a live-update connection stays idle in the idle
// check: past the server's 20-second ping, which keeps it open.
const idleWait = 25 * time.Second

func (s *smoke) idle(ctx context.Context) error {
	l, err := s.dialLive(ctx, s.nia, s.origin)
	if err != nil {
		return err
	}
	defer l.close()
	select {
	case <-time.After(idleWait):
	case <-ctx.Done():
		return ctx.Err()
	}
	return s.postAndReceive(ctx, s.nia, l, "smoke-idle-"+s.suffix)
}

func (s *smoke) enterLimit(ctx context.Context) error {
	c, err := s.client(nil)
	if err != nil {
		return err
	}
	attempt := func(forwardedFor string) (int, string, error) {
		res, err := c.PassAccessWithResponse(ctx, api.PassAccessJSONRequestBody{Password: "wrong " + s.suffix},
			func(_ context.Context, req *http.Request) error {
				if forwardedFor != "" {
					req.Header.Set("X-Forwarded-For", forwardedFor)
				}
				return nil
			})
		if err != nil {
			return 0, "", err
		}
		return res.StatusCode(), errorCode(res.Body), nil
	}
	// Each attempt claims to come from another address.
	limited := 0
	for i := 1; i <= enterBurst+1 && limited == 0; i++ {
		status, code, err := attempt(fmt.Sprintf("203.0.113.%d", i))
		switch {
		case err != nil:
			return err
		case status == http.StatusTooManyRequests && code == "rate_limited":
			limited = i
		case status != http.StatusForbidden || code != "invalid_access_password":
			return fmt.Errorf("a wrong access password answered %d %s, want 403 invalid_access_password or 429 rate_limited", status, code)
		}
	}
	if limited == 0 {
		return fmt.Errorf("no 429 after %d wrong access passwords, each with another X-Forwarded-For", enterBurst+1)
	}
	for _, forwardedFor := range []string{"198.51.100.7", "198.51.100.8, 203.0.113.250", "2001:db8::1", ""} {
		status, code, err := attempt(forwardedFor)
		if err != nil {
			return err
		}
		if status != http.StatusTooManyRequests || code != "rate_limited" {
			return fmt.Errorf("with X-Forwarded-For %q answered %d %s, want 429 rate_limited", forwardedFor, status, code)
		}
	}
	s.logf("429 from attempt %d; still 429 with other forged X-Forwarded-For values and with none", limited)
	return nil
}

// accountRequest sends an account request through c, waiting for the limit
// on account requests when a recent run has used it up.
func (s *smoke) accountRequest(ctx context.Context, send func() (int, error)) error {
	for waited := 0; ; waited++ {
		status, err := send()
		if err != nil || status != http.StatusTooManyRequests || waited >= enterBurst {
			return err
		}
		if waited == 0 {
			s.logf("the limit on account requests is used up, probably by a recent run; waiting")
		}
		select {
		case <-time.After(enterInterval):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// pass gives the access password and returns the pass cookie.
func (s *smoke) pass(ctx context.Context) (*http.Cookie, error) {
	c, err := s.client(nil)
	if err != nil {
		return nil, err
	}
	var res *api.PassAccessResponse
	err = s.accountRequest(ctx, func() (int, error) {
		var err error
		res, err = c.PassAccessWithResponse(ctx, api.PassAccessJSONRequestBody{Password: s.password})
		if err != nil {
			return 0, err
		}
		return res.StatusCode(), nil
	})
	if err != nil {
		return nil, err
	}
	if res.JSON200 == nil {
		return nil, fmt.Errorf("POST /api/access: %w", &statusError{res.StatusCode(), errorCode(res.Body)})
	}
	return findCookie(res.HTTPResponse, accessCookie)
}

func findCookie(res *http.Response, name string) (*http.Cookie, error) {
	for _, cookie := range res.Cookies() {
		if cookie.Name == name {
			return cookie, nil
		}
	}
	return nil, fmt.Errorf("%s set no %s cookie", res.Request.URL.Path, name)
}

// register gives the access password and registers login with name.
func (s *smoke) register(ctx context.Context, login, name string) (*visitor, error) {
	access, err := s.pass(ctx)
	if err != nil {
		return nil, err
	}
	c, err := s.client(access)
	if err != nil {
		return nil, err
	}
	var res *api.RegisterResponse
	err = s.accountRequest(ctx, func() (int, error) {
		var err error
		res, err = c.RegisterWithResponse(ctx, api.RegisterJSONRequestBody{Login: login, Password: password, Name: name})
		if err != nil {
			return 0, err
		}
		return res.StatusCode(), nil
	})
	if err != nil {
		return nil, err
	}
	if res.JSON200 == nil {
		return nil, fmt.Errorf("POST /api/accounts/register as %q: %w", name, &statusError{res.StatusCode(), errorCode(res.Body)})
	}
	cookie, err := findCookie(res.HTTPResponse, cookieName)
	if err != nil {
		return nil, err
	}
	vc, err := s.client(cookie)
	if err != nil {
		return nil, err
	}
	return &visitor{Visitor: res.JSON200.Session.Visitor, login: login, cookie: cookie, api: vc}, nil
}

// signIn gives the access password and signs login in with password.
func (s *smoke) signIn(ctx context.Context, login string) (*http.Cookie, error) {
	access, err := s.pass(ctx)
	if err != nil {
		return nil, err
	}
	c, err := s.client(access)
	if err != nil {
		return nil, err
	}
	var res *api.LoginResponse
	err = s.accountRequest(ctx, func() (int, error) {
		var err error
		res, err = c.LoginWithResponse(ctx, api.LoginJSONRequestBody{Login: login, Password: password})
		if err != nil {
			return 0, err
		}
		return res.StatusCode(), nil
	})
	if err != nil {
		return nil, err
	}
	if res.JSON200 == nil {
		return nil, fmt.Errorf("POST /api/accounts/login as %q: %w", login, &statusError{res.StatusCode(), errorCode(res.Body)})
	}
	return findCookie(res.HTTPResponse, cookieName)
}

// enterAs registers name with a login made from it.
func (s *smoke) enterAs(ctx context.Context, name string) (*visitor, error) {
	return s.register(ctx, strings.ToLower(strings.ReplaceAll(name, " ", "-")), name)
}
