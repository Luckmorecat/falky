package chat_test

import (
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

func TestAReplyShowsWhatItAnswersAsItReadsNow(t *testing.T) {
	f := newFixture(t)
	question := f.post(t, bob, f.lounge, "q", "Anyone up for a game\ntonight?")
	answer, created, err := f.chat.Reply(t.Context(), ann, f.lounge.ID, "a", question.ID, "Me!")
	if err != nil || !created {
		t.Fatalf("Reply = created %v, %v; want a new message", created, err)
	}
	want := chat.Reply{ID: question.ID, AuthorName: "Bob", Excerpt: "Anyone up for a game tonight?"}
	if answer.ReplyTo == nil || *answer.ReplyTo != want {
		t.Fatalf("ReplyTo = %+v, want %+v", answer.ReplyTo, want)
	}
	if _, err := f.chat.Delete(t.Context(), bob, f.lounge.ID, question.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got := f.history(t, f.lounge, chat.Page{Limit: 10})[0]
	if got.ID != answer.ID || got.ReplyTo == nil || !got.ReplyTo.Deleted || got.ReplyTo.Excerpt != "" {
		t.Errorf("after delete, history shows reply %+v, want it marked deleted with no excerpt", got.ReplyTo)
	}
}

func TestARetriedReplyMustNameTheSameMessage(t *testing.T) {
	f := newFixture(t)
	first := f.post(t, bob, f.lounge, "one", "first")
	second := f.post(t, bob, f.lounge, "two", "second")
	if _, _, err := f.chat.Reply(t.Context(), ann, f.lounge.ID, "k", first.ID, "yes"); err != nil {
		t.Fatalf("Reply: %v", err)
	}
	if _, created, err := f.chat.Reply(t.Context(), ann, f.lounge.ID, "k", first.ID, "yes"); err != nil || created {
		t.Errorf("same retry = created %v, %v; want the existing message", created, err)
	}
	if _, _, err := f.chat.Reply(t.Context(), ann, f.lounge.ID, "k", second.ID, "yes"); !errors.Is(err, chat.ErrRequestKeyReused) {
		t.Errorf("retry naming another message = %v, want ErrRequestKeyReused", err)
	}
}

func TestRepliesOnlyAnswerLiveMessagesOfTheSameRoom(t *testing.T) {
	f := newFixture(t)
	elsewhere := f.post(t, bob, f.game, "g", "in games")
	gone := f.post(t, bob, f.lounge, "x", "soon gone")
	if _, err := f.chat.Delete(t.Context(), bob, f.lounge.ID, gone.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	for name, id := range map[string]string{"another room": elsewhere.ID, "deleted": gone.ID, "unknown": "01JBX6Z8Q3M5W2K7R9T4V1C0DE"} {
		if _, _, err := f.chat.Reply(t.Context(), ann, f.lounge.ID, "r-"+strings.ReplaceAll(name, " ", "-"), id, "hm"); !errors.Is(err, chat.ErrInvalidReply) {
			t.Errorf("reply to %s message = %v, want ErrInvalidReply", name, err)
		}
	}
}

func TestOnlyTheAuthorEditsAndDeletesAndADeletedMessageShowsNothing(t *testing.T) {
	clock := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	f := newFixture(t, chat.WithClock(func() time.Time { return clock }))
	m := f.post(t, bob, f.lounge, "k", "helo")
	if _, err := f.chat.Edit(t.Context(), ann, f.lounge.ID, m.ID, "hello"); !errors.Is(err, chat.ErrNotAuthor) {
		t.Errorf("Edit by another = %v, want ErrNotAuthor", err)
	}
	if _, err := f.chat.Edit(t.Context(), bob, f.game.ID, m.ID, "hello"); !errors.Is(err, chat.ErrNotFound) {
		t.Errorf("Edit in another room = %v, want ErrNotFound", err)
	}
	if _, err := f.chat.Edit(t.Context(), bob, f.lounge.ID, m.ID, "  "); !errors.Is(err, chat.ErrInvalidBody) {
		t.Errorf("Edit to blank = %v, want ErrInvalidBody", err)
	}
	clock = clock.Add(time.Minute)
	edited, err := f.chat.Edit(t.Context(), bob, f.lounge.ID, m.ID, "hello")
	if err != nil || edited.Body != "hello" || !edited.EditedAt.Equal(clock) {
		t.Fatalf("Edit = %+v, %v; want the new text edited at %v", edited, err, clock)
	}
	if _, err := f.chat.React(t.Context(), ann, f.lounge.ID, m.ID, "fire", true); err != nil {
		t.Fatalf("React: %v", err)
	}
	if _, err := f.chat.Delete(t.Context(), ann, f.lounge.ID, m.ID); !errors.Is(err, chat.ErrNotAuthor) {
		t.Errorf("Delete by another = %v, want ErrNotAuthor", err)
	}
	deleted, err := f.chat.Delete(t.Context(), bob, f.lounge.ID, m.ID)
	if err != nil || !deleted.Deleted || deleted.Body != "" || len(deleted.Reactions) != 0 {
		t.Fatalf("Delete = %+v, %v; want it deleted with no text or reactions", deleted, err)
	}
	if again, err := f.chat.Delete(t.Context(), bob, f.lounge.ID, m.ID); err != nil || !again.Deleted {
		t.Errorf("second Delete = %+v, %v; want the same deleted message", again, err)
	}
	if _, err := f.chat.Edit(t.Context(), bob, f.lounge.ID, m.ID, "back"); !errors.Is(err, chat.ErrDeleted) {
		t.Errorf("Edit after delete = %v, want ErrDeleted", err)
	}
	if _, err := f.chat.React(t.Context(), ann, f.lounge.ID, m.ID, "up", true); !errors.Is(err, chat.ErrDeleted) {
		t.Errorf("React after delete = %v, want ErrDeleted", err)
	}
	if got := f.history(t, f.lounge, chat.Page{Limit: 10})[0]; !got.Deleted || got.Body != "" {
		t.Errorf("history shows %+v, want the message deleted", got)
	}
}

func TestReactionsAreListedInOrderWithWhoGaveThemAndToggleIdempotently(t *testing.T) {
	f := newFixture(t)
	m := f.post(t, bob, f.lounge, "k", "nice")
	react := func(who identity.Visitor, reaction string, on bool) chat.Message {
		t.Helper()
		got, err := f.chat.React(t.Context(), who, f.lounge.ID, m.ID, reaction, on)
		if err != nil {
			t.Fatalf("React(%s, %s, %v): %v", who.Name, reaction, on, err)
		}
		return got
	}
	react(ann, "fire", true)
	react(bob, "up", true)
	react(bob, "fire", true)
	got := react(bob, "fire", true)
	want := []chat.ReactionGroup{{Reaction: "up", VisitorIDs: []string{bob.ID}}, {Reaction: "fire", VisitorIDs: []string{ann.ID, bob.ID}}}
	if !slices.EqualFunc(got.Reactions, want, sameGroup) {
		t.Errorf("Reactions = %+v, want %+v", got.Reactions, want)
	}
	react(ann, "fire", false)
	got = react(ann, "fire", false)
	want = []chat.ReactionGroup{{Reaction: "up", VisitorIDs: []string{bob.ID}}, {Reaction: "fire", VisitorIDs: []string{bob.ID}}}
	if !slices.EqualFunc(got.Reactions, want, sameGroup) {
		t.Errorf("after taking one back, Reactions = %+v, want %+v", got.Reactions, want)
	}
	if _, err := f.chat.React(t.Context(), ann, f.lounge.ID, m.ID, "skull", true); !errors.Is(err, chat.ErrInvalidReaction) {
		t.Errorf("React(skull) = %v, want ErrInvalidReaction", err)
	}
	if got := f.history(t, f.lounge, chat.Page{Limit: 10})[0]; !slices.EqualFunc(got.Reactions, want, sameGroup) {
		t.Errorf("history Reactions = %+v, want %+v", got.Reactions, want)
	}
}

func TestOnlyRealChangesArePublishedAndReactionsAreLimited(t *testing.T) {
	var mu sync.Mutex
	var published []string
	f := newFixture(t,
		chat.WithUpdatePublisher(func(m chat.Message) {
			mu.Lock()
			defer mu.Unlock()
			published = append(published, m.ID)
		}),
		chat.WithReactLimit(platform.NewLimiter(2, time.Hour, time.Now)))
	m := f.post(t, bob, f.lounge, "k", "hi")
	steps := []func() error{
		func() error { _, err := f.chat.Edit(t.Context(), bob, f.lounge.ID, m.ID, "hi"); return err },
		func() error { _, err := f.chat.Edit(t.Context(), bob, f.lounge.ID, m.ID, "hey"); return err },
		func() error { _, err := f.chat.React(t.Context(), ann, f.lounge.ID, m.ID, "up", false); return err },
		func() error { _, err := f.chat.React(t.Context(), ann, f.lounge.ID, m.ID, "up", true); return err },
		func() error { _, err := f.chat.React(t.Context(), ann, f.lounge.ID, m.ID, "up", true); return err },
		func() error { _, err := f.chat.React(t.Context(), ann, f.lounge.ID, m.ID, "up", false); return err },
	}
	for i, step := range steps {
		if err := step(); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
	}
	if _, err := f.chat.React(t.Context(), ann, f.lounge.ID, m.ID, "heart", true); !errors.Is(err, chat.ErrRateLimited) {
		t.Errorf("third reaction change = %v, want ErrRateLimited", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(published) != 3 {
		t.Errorf("published %d updates, want 3: the edit and two reaction changes", len(published))
	}
}

func sameGroup(a, b chat.ReactionGroup) bool {
	return a.Reaction == b.Reaction && slices.Equal(a.VisitorIDs, b.VisitorIDs)
}
