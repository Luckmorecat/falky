package httpapi

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/rooms"
)

func (p publicServer) createRoom(t *testing.T, name string) rooms.Room {
	t.Helper()
	r, err := p.rooms.Create(t.Context(), name)
	if err != nil {
		t.Fatalf("Create(%q): %v", name, err)
	}
	return r
}

// attemptPost posts body under key in roomID through b and returns the
// response, whatever it is.
func attemptPost(t *testing.T, b *api.ClientWithResponses, roomID, key, body string) *api.PostMessageResponse {
	t.Helper()
	res, err := b.PostMessageWithResponse(t.Context(), roomID, api.PostMessageRequest{RequestKey: key, Body: body})
	if err != nil {
		t.Fatalf("PostMessage: %v", err)
	}
	return res
}

// posted posts body under key in roomID through b and fails the test unless
// it creates a message.
func posted(t *testing.T, b *api.ClientWithResponses, roomID, key, body string) api.Message {
	t.Helper()
	res := attemptPost(t, b, roomID, key, body)
	if res.StatusCode() != http.StatusCreated || res.JSON201 == nil {
		t.Fatalf("PostMessage(%q, %q) = %d %s, want 201", key, body, res.StatusCode(), res.Body)
	}
	return *res.JSON201
}

// history reads a page of roomID's chat through b and fails the test unless
// it succeeds.
func history(t *testing.T, b *api.ClientWithResponses, roomID string, params api.ListMessagesParams) []api.Message {
	t.Helper()
	res, err := b.ListMessagesWithResponse(t.Context(), roomID, &params)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil {
		t.Fatalf("ListMessages(%+v) = %d %s, want 200", params, res.StatusCode(), res.Body)
	}
	return res.JSON200.Messages
}

func messageIDs(ms []api.Message) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.Id
	}
	return out
}

func TestRoomChatNeedsAVisitor(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	list, err := b.ListMessagesWithResponse(t.Context(), lounge.ID, nil)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	wantError(t, "ListMessages without a cookie", list.StatusCode(), list.Body, http.StatusUnauthorized, "visitor_required")
	res := attemptPost(t, b, lounge.ID, "k1", "hello")
	wantError(t, "PostMessage without a cookie", res.StatusCode(), res.Body, http.StatusUnauthorized, "visitor_required")
}

func TestUnknownRoomsAnswerNotFound(t *testing.T) {
	p := startPublic(t, 10)
	b := p.browser(t)
	p.enter(t, b, "Bob")
	unknown := "01JBX6Z8Q3M5W2K7R9T4V1C0DE"

	list, err := b.ListMessagesWithResponse(t.Context(), unknown, nil)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	wantError(t, "ListMessages of an unknown room", list.StatusCode(), list.Body, http.StatusNotFound, "room_not_found")
	res := attemptPost(t, b, unknown, "k1", "hello")
	wantError(t, "PostMessage in an unknown room", res.StatusCode(), res.Body, http.StatusNotFound, "room_not_found")
}

func TestPostingIsIdempotentByRequestKey(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	bob := p.enter(t, b, "Bob")

	created := posted(t, b, lounge.ID, "k1", "hello")
	if created.Id == "" || created.RoomId != lounge.ID || created.AuthorId != bob.Id ||
		created.AuthorName != "Bob" || created.Body != "hello" || created.CreatedAt.IsZero() {
		t.Errorf("PostMessage = %+v, want a message by Bob in the room", created)
	}

	again := attemptPost(t, b, lounge.ID, "k1", "hello")
	if again.StatusCode() != http.StatusOK || again.JSON200 == nil || *again.JSON200 != created {
		t.Errorf("PostMessage repeated = %d %s, want 200 with %+v", again.StatusCode(), again.Body, created)
	}
	changed := attemptPost(t, b, lounge.ID, "k1", "hello?")
	wantError(t, "PostMessage with the same key and another body", changed.StatusCode(), changed.Body, http.StatusConflict, "request_key_reused")

	if got := history(t, b, lounge.ID, api.ListMessagesParams{}); len(got) != 1 || got[0] != created {
		t.Errorf("history = %+v, want only %+v", got, created)
	}
}

func TestPostingRefusesInvalidMessages(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	p.enter(t, b, "Bob")

	for name, tc := range map[string]struct {
		key, body string
		code      string
	}{
		"an empty body":          {"k1", "", "invalid_message"},
		"a white-space body":     {"k2", "  \n ", "invalid_message"},
		"a 4001-character body":  {"k3", strings.Repeat("a", 4001), "invalid_message"},
		"an empty request key":   {"", "hello", "invalid_request"},
		"a request key with a /": {"k/4", "hello", "invalid_request"},
	} {
		res := attemptPost(t, b, lounge.ID, tc.key, tc.body)
		wantError(t, "PostMessage with "+name, res.StatusCode(), res.Body, http.StatusBadRequest, tc.code)
	}
	posted(t, b, lounge.ID, "k5", strings.Repeat("a", 4000))
}

func TestHistoryPagesBackwardsAndForwards(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	p.enter(t, b, "Bob")
	var ids []string
	for i := range 55 {
		ids = append(ids, posted(t, b, lounge.ID, fmt.Sprintf("k%d", i), fmt.Sprintf("message %d", i)).Id)
	}
	newestFirst := slices.Clone(ids)
	slices.Reverse(newestFirst)
	limit := func(n int) *int { return &n }

	for name, tc := range map[string]struct {
		params api.ListMessagesParams
		want   []string
	}{
		"newest, default limit": {api.ListMessagesParams{}, newestFirst[:50]},
		"before":                {api.ListMessagesParams{Before: ids[10], Limit: limit(3)}, []string{ids[9], ids[8], ids[7]}},
		"before the first":      {api.ListMessagesParams{Before: ids[0]}, []string{}},
		"after":                 {api.ListMessagesParams{After: ids[50]}, ids[51:]},
		"after, limited":        {api.ListMessagesParams{After: ids[0], Limit: limit(2)}, []string{ids[1], ids[2]}},
		"maximum limit":         {api.ListMessagesParams{Limit: limit(100)}, newestFirst},
	} {
		if got := messageIDs(history(t, b, lounge.ID, tc.params)); !slices.Equal(got, tc.want) {
			t.Errorf("history %s = %v, want %v", name, got, tc.want)
		}
	}

	for name, params := range map[string]api.ListMessagesParams{
		"before and after": {Before: ids[10], After: ids[5]},
		"limit 101":        {Limit: limit(101)},
		"limit 0":          {Limit: limit(0)},
		"a bad cursor":     {After: "nope"},
	} {
		res, err := b.ListMessagesWithResponse(t.Context(), lounge.ID, &params)
		if err != nil {
			t.Fatalf("ListMessages: %v", err)
		}
		wantError(t, "ListMessages with "+name, res.StatusCode(), res.Body, http.StatusBadRequest, "invalid_request")
	}
}

func TestMessagesKeepTheNameTheirAuthorHadWhenPosting(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	b := p.browser(t)
	p.enter(t, b, "Bob")

	before := posted(t, b, lounge.ID, "k1", "hello")
	if res, err := b.RenameMeWithResponse(t.Context(), api.RenameRequest{Name: "Rob"}); err != nil || res.StatusCode() != http.StatusOK {
		t.Fatalf("RenameMe = %v, %v, want 200", res, err)
	}
	after := posted(t, b, lounge.ID, "k2", "it's Rob now")
	if before.AuthorName != "Bob" || after.AuthorName != "Rob" || after.AuthorId != before.AuthorId {
		t.Errorf("posted authors = %s, %s, want Bob then Rob, the same visitor", before.AuthorName, after.AuthorName)
	}
	got := history(t, b, lounge.ID, api.ListMessagesParams{})
	if len(got) != 2 || got[0].AuthorName != "Rob" || got[1].AuthorName != "Bob" {
		t.Errorf("history = %+v, want Rob's message then Bob's", got)
	}
}

func TestPostingIsLimitedPerVisitor(t *testing.T) {
	p := startPublicLimited(t, 10, 2)
	lounge := p.createRoom(t, "Lounge")
	bob, ann := p.browser(t), p.browser(t)
	p.enter(t, bob, "Bob")
	p.enter(t, ann, "Ann")

	posted(t, bob, lounge.ID, "k1", "one")
	posted(t, bob, lounge.ID, "k2", "two")
	res := attemptPost(t, bob, lounge.ID, "k3", "three")
	wantError(t, "PostMessage beyond the limit", res.StatusCode(), res.Body, http.StatusTooManyRequests, "rate_limited")
	// Posting a stored message again is not limited: it creates nothing.
	if retry := attemptPost(t, bob, lounge.ID, "k2", "two"); retry.StatusCode() != http.StatusOK {
		t.Errorf("retry beyond the limit = %d %s, want 200 with the original message", retry.StatusCode(), retry.Body)
	}
	posted(t, ann, lounge.ID, "k1", "Ann has her own limit")

	if got := history(t, bob, lounge.ID, api.ListMessagesParams{}); len(got) != 3 {
		t.Errorf("history = %+v, want the three allowed messages", got)
	}
}
