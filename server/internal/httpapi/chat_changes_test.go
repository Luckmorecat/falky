package httpapi

import (
	"net/http"
	"slices"
	"testing"

	"github.com/kisshot/falky/server/internal/api"
)

func TestRepliesNameWhatTheyAnswerAndRefuseOtherRooms(t *testing.T) {
	p := startPublic(t, 10)
	lounge, games := p.createRoom(t, "Lounge"), p.createRoom(t, "Games")
	bob := p.browser(t)
	p.enter(t, bob, "Bob")
	question := posted(t, bob, lounge.ID, "q", "Anyone up for a game?")
	elsewhere := posted(t, bob, games.ID, "g", "in games")

	res, err := bob.PostMessageWithResponse(t.Context(), lounge.ID, api.PostMessageRequest{RequestKey: "a", Body: "Me", ReplyTo: question.Id})
	if err != nil || res.JSON201 == nil {
		t.Fatalf("reply = %v %s, want 201", err, res.Body)
	}
	if r := res.JSON201.ReplyTo; r == nil || r.Id != question.Id || r.AuthorName != "Bob" || r.Excerpt != "Anyone up for a game?" {
		t.Errorf("replyTo = %+v, want Bob's question", r)
	}
	res, err = bob.PostMessageWithResponse(t.Context(), lounge.ID, api.PostMessageRequest{RequestKey: "b", Body: "Me", ReplyTo: elsewhere.Id})
	if err != nil {
		t.Fatalf("PostMessage: %v", err)
	}
	wantError(t, "reply to another room's message", res.StatusCode(), res.Body, http.StatusBadRequest, "invalid_reply")
}

func TestOnlyTheAuthorEditsAndDeletesAndEveryoneInTheRoomSeesIt(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	bob := p.browser(t)
	p.enter(t, bob, "Bob")
	ann, annHTTP := p.browserWithHTTP(t)
	p.enter(t, ann, "Ann")
	m := posted(t, bob, lounge.ID, "k", "helo")
	live := p.connectLive(t, annHTTP)

	byAnn, err := ann.EditMessageWithResponse(t.Context(), lounge.ID, m.Id, api.EditMessageRequest{Body: "hacked"})
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	wantError(t, "edit by another", byAnn.StatusCode(), byAnn.Body, http.StatusForbidden, "not_author")
	missing, err := bob.EditMessageWithResponse(t.Context(), lounge.ID, "01JBX6Z8Q3M5W2K7R9T4V1C0DE", api.EditMessageRequest{Body: "x"})
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	wantError(t, "edit of an unknown message", missing.StatusCode(), missing.Body, http.StatusNotFound, "message_not_found")

	edited, err := bob.EditMessageWithResponse(t.Context(), lounge.ID, m.Id, api.EditMessageRequest{Body: "hello"})
	if err != nil || edited.JSON200 == nil || edited.JSON200.Body != "hello" || edited.JSON200.EditedAt == nil {
		t.Fatalf("edit = %v %s, want the new text with editedAt", err, edited.Body)
	}
	e := nextEvent(t, live)
	got, err := e.Payload.AsMessage()
	if e.Type != api.EventTypeMessageUpdated || err != nil || got.Body != "hello" {
		t.Fatalf("Ann got %s %+v, want message.updated with the new text", e.Type, got)
	}

	deleted, err := bob.DeleteMessageWithResponse(t.Context(), lounge.ID, m.Id)
	if err != nil || deleted.JSON200 == nil || !deleted.JSON200.Deleted || deleted.JSON200.Body != "" {
		t.Fatalf("delete = %v %s, want it deleted", err, deleted.Body)
	}
	if e := nextEvent(t, live); e.Type != api.EventTypeMessageUpdated {
		t.Errorf("Ann got %s after delete, want message.updated", e.Type)
	}
	after, err := bob.EditMessageWithResponse(t.Context(), lounge.ID, m.Id, api.EditMessageRequest{Body: "back"})
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	wantError(t, "edit after delete", after.StatusCode(), after.Body, http.StatusConflict, "message_deleted")
	if h := history(t, ann, lounge.ID, api.ListMessagesParams{}); len(h) != 1 || !h[0].Deleted {
		t.Errorf("history = %+v, want the one message, deleted", h)
	}
}

func TestReactionsToggleAndOnlyListedOnesAreAccepted(t *testing.T) {
	p := startPublic(t, 10)
	lounge := p.createRoom(t, "Lounge")
	bob := p.browser(t)
	bobVisitor := p.enter(t, bob, "Bob")
	ann := p.browser(t)
	annVisitor := p.enter(t, ann, "Ann")
	m := posted(t, bob, lounge.ID, "k", "nice")

	for _, b := range []*api.ClientWithResponses{ann, bob, ann} {
		if res, err := b.AddReactionWithResponse(t.Context(), lounge.ID, m.Id, api.MessageReactionFire); err != nil || res.JSON200 == nil {
			t.Fatalf("AddReaction = %v %s, want 200", err, res.Body)
		}
	}
	res, err := ann.RemoveReactionWithResponse(t.Context(), lounge.ID, m.Id, api.MessageReactionFire)
	if err != nil || res.JSON200 == nil {
		t.Fatalf("RemoveReaction = %v %s, want 200", err, res.Body)
	}
	want := []api.ReactionGroup{{Reaction: api.MessageReactionFire, VisitorIds: []string{bobVisitor.Id}}}
	if got := res.JSON200.Reactions; !slices.EqualFunc(got, want, func(a, b api.ReactionGroup) bool {
		return a.Reaction == b.Reaction && slices.Equal(a.VisitorIds, b.VisitorIds)
	}) {
		t.Errorf("reactions = %+v, want only Bob's fire (not Ann %s)", got, annVisitor.Id)
	}
	bad, err := ann.AddReactionWithResponse(t.Context(), lounge.ID, m.Id, "skull")
	if err != nil {
		t.Fatalf("AddReaction: %v", err)
	}
	wantError(t, "unknown reaction", bad.StatusCode(), bad.Body, http.StatusBadRequest, "invalid_request")
}
