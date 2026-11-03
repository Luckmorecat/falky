package chat_test

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
)

// fixture is a chat service on a temporary database with two rooms.
type fixture struct {
	db           *platform.DB
	chat         *chat.Service
	lounge, game rooms.Room
}

func newFixture(t *testing.T, opts ...chat.Option) fixture {
	t.Helper()
	ms, err := platform.LoadMigrations(rooms.Migrations(), chat.Migrations())
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	db, err := platform.OpenDB(t.Context(), filepath.Join(t.TempDir(), "falky.db"))
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	if _, err := db.Migrate(t.Context(), ms); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	rs := rooms.New(db)
	f := fixture{db: db, chat: chat.New(db, opts...)}
	for name, r := range map[string]*rooms.Room{"Lounge": &f.lounge, "Games": &f.game} {
		if *r, err = rs.Create(t.Context(), name); err != nil {
			t.Fatalf("Create(%q): %v", name, err)
		}
	}
	return f
}

var (
	bob = identity.Visitor{ID: ulid.Make().String(), Name: "Bob"}
	ann = identity.Visitor{ID: ulid.Make().String(), Name: "Ann"}
)

var ulidPattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

func (f fixture) post(t *testing.T, author identity.Visitor, room rooms.Room, key, body string) chat.Message {
	t.Helper()
	m, created, err := f.chat.Post(t.Context(), author, room.ID, key, body)
	if err != nil || !created {
		t.Fatalf("Post(%s, %q, %q) = created %v, %v; want a new message", author.Name, key, body, created, err)
	}
	return m
}

func (f fixture) history(t *testing.T, room rooms.Room, page chat.Page) []chat.Message {
	t.Helper()
	got, err := f.chat.History(t.Context(), room.ID, page)
	if err != nil {
		t.Fatalf("History(%+v): %v", page, err)
	}
	return got
}

func ids(ms []chat.Message) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.ID
	}
	return out
}

func TestPostingCreatesAMessageUnderTheAuthorsName(t *testing.T) {
	f := newFixture(t)
	before := time.Now().Add(-time.Second)
	m := f.post(t, bob, f.lounge, "k1", "  hello  ")
	if !ulidPattern.MatchString(m.ID) || m.RoomID != f.lounge.ID || m.AuthorID != bob.ID ||
		m.AuthorName != "Bob" || m.Body != "  hello  " || m.CreatedAt.Before(before) || m.CreatedAt.After(time.Now()) {
		t.Errorf("Post = %+v, want a ULID, the room, Bob and the body as sent, created now", m)
	}
	if got := f.history(t, f.lounge, chat.Page{Limit: 10}); len(got) != 1 || got[0] != m {
		t.Errorf("History = %+v, want only %+v", got, m)
	}
}

func TestRepeatingARequestKeyReturnsTheOriginalMessage(t *testing.T) {
	f := newFixture(t)
	original := f.post(t, bob, f.lounge, "k1", "hello")

	again, created, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k1", "hello")
	if err != nil || created || again != original {
		t.Errorf("Post with the same key and body = %+v, created %v, %v; want %+v, not created", again, created, err, original)
	}
	for name, p := range map[string]struct{ room, body string }{
		"a different body": {f.lounge.ID, "hello?"},
		"another room":     {f.game.ID, "hello"},
	} {
		if _, _, err := f.chat.Post(t.Context(), bob, p.room, "k1", p.body); !errors.Is(err, chat.ErrRequestKeyReused) {
			t.Errorf("Post with the same key in %s: err = %v, want ErrRequestKeyReused", name, err)
		}
	}
	// Keys are per author.
	f.post(t, ann, f.lounge, "k1", "hello")

	if got := f.history(t, f.lounge, chat.Page{Limit: 10}); len(got) != 2 {
		t.Errorf("History = %+v, want Bob's and Ann's messages only", got)
	}
	if got := f.history(t, f.game, chat.Page{Limit: 10}); len(got) != 0 {
		t.Errorf("History of the other room = %+v, want none", got)
	}
}

func TestPostingRefusesInvalidBodiesAndRequestKeys(t *testing.T) {
	f := newFixture(t)
	for name, body := range map[string]string{
		"empty":            "",
		"only white space": " \n\t ",
		"4001 characters":  strings.Repeat("é", 4001),
		"invalid UTF-8":    "\xff",
	} {
		if _, _, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k-"+strings.ReplaceAll(name, " ", "-"), body); !errors.Is(err, chat.ErrInvalidBody) {
			t.Errorf("Post with a body %s: err = %v, want ErrInvalidBody", name, err)
		}
	}
	for _, key := range []string{"", strings.Repeat("k", 65), "a b", "ключ", "k/1"} {
		if _, _, err := f.chat.Post(t.Context(), bob, f.lounge.ID, key, "hello"); !errors.Is(err, chat.ErrInvalidRequestKey) {
			t.Errorf("Post with key %q: err = %v, want ErrInvalidRequestKey", key, err)
		}
	}
	if got := f.history(t, f.lounge, chat.Page{Limit: 10}); len(got) != 0 {
		t.Errorf("History after refused posting = %+v, want none", got)
	}

	f.post(t, bob, f.lounge, strings.Repeat("K", 64), strings.Repeat("😀", 4000))
	f.post(t, bob, f.lounge, "3f1c2a9e-7b4d-4e8a-9c61-2d5f0b8e7a13", "x")
	f.post(t, bob, f.lounge, "under_score", "y")
}

// committedIDs returns every message ID in the order the messages were
// inserted, which is the order their transactions committed in, since there is
// one writer.
func committedIDs(t *testing.T, db *platform.DB) []string {
	t.Helper()
	rows, err := db.Read().QueryContext(t.Context(), "SELECT id FROM messages ORDER BY rowid")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			t.Errorf("rows.Close: %v", err)
		}
	}()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return out
}

func TestConcurrentPostsGetIDsInCommitOrder(t *testing.T) {
	f := newFixture(t)
	var wg sync.WaitGroup
	for i := range 40 {
		wg.Go(func() {
			author := bob
			if i%2 == 1 {
				author = ann
			}
			if _, _, err := f.chat.Post(t.Context(), author, f.lounge.ID, fmt.Sprintf("k%d", i), "hi"); err != nil {
				t.Errorf("Post %d: %v", i, err)
			}
		})
	}
	wg.Wait()

	got := committedIDs(t, f.db)
	if len(got) != 40 || !slices.IsSorted(got) {
		t.Errorf("IDs in commit order = %v, want 40 ascending IDs", got)
	}
	// Paging forwards from the start sees them in the same order.
	if after := f.history(t, f.lounge, chat.Page{After: "00000000000000000000000000", Limit: 100}); !slices.Equal(ids(after), got) {
		t.Errorf("History after the start = %v, want %v", ids(after), got)
	}
}

func TestIDsStayInCommitOrderWhenTheClockGoesBack(t *testing.T) {
	clock := time.Date(2026, 11, 4, 18, 0, 0, 0, time.UTC)
	f := newFixture(t, chat.WithClock(func() time.Time { return clock }))
	var posted []string
	for i, step := range []time.Duration{0, -time.Hour, 0, -time.Minute, 2 * time.Hour} {
		clock = clock.Add(step)
		posted = append(posted, f.post(t, bob, f.lounge, fmt.Sprintf("k%d", i), "hi").ID)
	}
	if !slices.IsSorted(posted) || len(slices.Compact(slices.Clone(posted))) != len(posted) {
		t.Errorf("IDs = %v, want strictly ascending", posted)
	}
	if got := committedIDs(t, f.db); !slices.Equal(got, posted) {
		t.Errorf("IDs in commit order = %v, want %v", got, posted)
	}
}

func TestHistoryPagesBackwardsAndForwards(t *testing.T) {
	f := newFixture(t)
	var m []string
	for i := range 5 {
		m = append(m, f.post(t, bob, f.lounge, fmt.Sprintf("k%d", i), fmt.Sprintf("message %d", i)).ID)
		f.post(t, bob, f.game, fmt.Sprintf("g%d", i), "elsewhere")
	}

	for name, tc := range map[string]struct {
		page chat.Page
		want []string
	}{
		"newest":            {chat.Page{Limit: 2}, []string{m[4], m[3]}},
		"before":            {chat.Page{Before: m[3], Limit: 2}, []string{m[2], m[1]}},
		"before the second": {chat.Page{Before: m[1], Limit: 2}, []string{m[0]}},
		"before the first":  {chat.Page{Before: m[0], Limit: 2}, []string{}},
		"after":             {chat.Page{After: m[0], Limit: 3}, []string{m[1], m[2], m[3]}},
		"after the last":    {chat.Page{After: m[4], Limit: 3}, []string{}},
		"after, lowercase":  {chat.Page{After: strings.ToLower(m[2]), Limit: 3}, []string{m[3], m[4]}},
		"everything":        {chat.Page{Limit: chat.MaxLimit}, []string{m[4], m[3], m[2], m[1], m[0]}},
	} {
		if got := ids(f.history(t, f.lounge, tc.page)); !slices.Equal(got, tc.want) {
			t.Errorf("History %s (%+v) = %v, want %v", name, tc.page, got, tc.want)
		}
	}
}

func TestHistoryRefusesInvalidPages(t *testing.T) {
	f := newFixture(t)
	id := f.post(t, bob, f.lounge, "k", "hi").ID
	for name, page := range map[string]chat.Page{
		"before and after": {Before: id, After: id, Limit: 10},
		"limit 0":          {Limit: 0},
		"negative limit":   {Limit: -1},
		"limit 101":        {Limit: chat.MaxLimit + 1},
		"bad cursor":       {Before: "nope", Limit: 10},
	} {
		if _, err := f.chat.History(t.Context(), f.lounge.ID, page); !errors.Is(err, chat.ErrInvalidPage) {
			t.Errorf("History %s: err = %v, want ErrInvalidPage", name, err)
		}
	}
}

func TestPostLimitCountsNewMessagesOnly(t *testing.T) {
	start := time.Now()
	f := newFixture(t, chat.WithPostLimit(platform.NewLimiter(2, time.Hour, func() time.Time { return start })))
	f.post(t, bob, f.lounge, "k1", "one")
	if _, _, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k1", "one"); err != nil {
		t.Fatalf("retry within the limit: %v", err)
	}
	f.post(t, bob, f.lounge, "k2", "two")
	if _, _, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k3", "three"); !errors.Is(err, chat.ErrRateLimited) {
		t.Errorf("third new message: err = %v, want ErrRateLimited", err)
	}
	if _, created, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k2", "two"); err != nil || created {
		t.Errorf("retry beyond the limit = created %v, %v; want the original message", created, err)
	}
	f.post(t, ann, f.lounge, "k3", "Ann has her own limit")
}

func TestPostingPublishesCommittedNewMessagesOnly(t *testing.T) {
	var published []chat.Message
	var historyThen []string
	var f fixture
	f = newFixture(t,
		chat.WithPostLimit(platform.NewLimiter(2, time.Hour, time.Now)),
		chat.WithPublisher(func(m chat.Message) {
			published = append(published, m)
			historyThen = ids(f.history(t, rooms.Room{ID: m.RoomID}, chat.Page{Limit: chat.MaxLimit}))
		}))

	m := f.post(t, bob, f.lounge, "k1", "hello")
	if !slices.Equal(published, []chat.Message{m}) {
		t.Fatalf("published after Post = %+v, want the new message %+v", published, m)
	}
	if !slices.Equal(historyThen, []string{m.ID}) {
		t.Errorf("history while publishing = %v, want the message committed", historyThen)
	}

	published = nil
	if _, created, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k1", "hello"); err != nil || created {
		t.Fatalf("repeated Post = created %v, %v; want the stored message", created, err)
	}
	f.post(t, bob, f.lounge, "k2", "second") // spends the limit
	published = nil
	for name, attempt := range map[string]func() error{
		"repeat":         func() error { _, _, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k2", "second"); return err },
		"key reused":     func() error { _, _, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k1", "other"); return err },
		"empty body":     func() error { _, _, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k3", " "); return err },
		"over the limit": func() error { _, _, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "k4", "third"); return err },
		"invalid key":    func() error { _, _, err := f.chat.Post(t.Context(), bob, f.lounge.ID, "", "x"); return err },
	} {
		_ = attempt()
		if len(published) != 0 {
			t.Errorf("%s published %+v, want nothing", name, published)
			published = nil
		}
	}
}

func TestMessagesArePublishedInTheOrderTheyAreCommitted(t *testing.T) {
	publishing := make(chan string, 1)
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	var published []string
	f := newFixture(t, chat.WithPublisher(func(m chat.Message) {
		mu.Lock()
		calls++
		holds := calls == 1 // the first message is slow to publish
		mu.Unlock()
		if holds {
			publishing <- m.ID
			<-release
		}
		mu.Lock()
		published = append(published, m.ID)
		mu.Unlock()
	}))

	var wg sync.WaitGroup
	wg.Go(func() { f.post(t, bob, f.lounge, "k1", "first") })
	first := <-publishing
	// While the first message is still being published, a second one is
	// posted; it must not be published ahead of the first.
	wg.Go(func() { f.post(t, ann, f.lounge, "k1", "second") })
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	committed := ids(f.history(t, f.lounge, chat.Page{Limit: chat.MaxLimit}))
	slices.Reverse(committed) // the history lists the newest first
	if len(published) != 2 || published[0] != first || !slices.Equal(published, committed) {
		t.Errorf("published %v, want the commit order %v with %s first", published, committed, first)
	}
}
