package chat

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kisshot/falky/server/internal/attachments"
	"github.com/kisshot/falky/server/internal/identity"
)

// Reactions are the reactions a message can be given, in the order they are
// listed. They match the reactions sent in a room's voice.
var Reactions = []string{"up", "heart", "laugh", "wow", "fire", "clap"}

// ReactionGroup is one reaction on a message and who gave it, earliest first.
type ReactionGroup struct {
	Reaction   string
	VisitorIDs []string
}

// Reply is the message another answers, as it reads now.
type Reply struct {
	ID         string
	AuthorName string
	// Excerpt is the start of its text on one line, at most excerptLength
	// characters; empty once it is deleted or when it has only attachments.
	Excerpt string
	Deleted bool
}

const excerptLength = 120

var (
	// ErrNotFound reports a message that is not in the room named.
	ErrNotFound = errors.New("no such message in this room")
	// ErrNotAuthor reports a change only the message's author may make.
	ErrNotAuthor = errors.New("only the author can change this message")
	// ErrDeleted reports a change to a message that was deleted.
	ErrDeleted = errors.New("the message was deleted")
	// ErrInvalidReply reports a reply to a message that is not in the room or
	// was deleted.
	ErrInvalidReply = errors.New("can only reply to a message of this room that still exists")
	// ErrInvalidReaction reports a reaction that is not one of Reactions.
	ErrInvalidReaction = errors.New("unknown reaction")
)

// Edit replaces the text of the author's message messageID in the room
// roomID with body, under the rules Post checks. Text that is already body
// changes nothing. It fails with ErrNotFound, ErrNotAuthor, ErrDeleted or an
// ErrInvalidBody; a message with attachments may be edited to empty text.
func (s *Service) Edit(ctx context.Context, author identity.Visitor, roomID, messageID, body string) (Message, error) {
	return s.change(ctx, roomID, messageID, func(tx *sql.Tx, m *Message) (bool, error) {
		switch {
		case m.AuthorID != author.ID:
			return false, ErrNotAuthor
		case m.Deleted:
			return false, ErrDeleted
		case m.Body == body:
			return false, nil
		}
		if err := checkBodyWithAttachments(body, len(m.Attachments)); err != nil {
			return false, err
		}
		now := s.now().UTC().Truncate(time.Millisecond)
		if _, err := tx.ExecContext(ctx, "UPDATE messages SET body = ?, edited_at = ? WHERE id = ?", body, now.Format(timeLayout), m.ID); err != nil {
			return false, err
		}
		m.Body, m.EditedAt = body, now
		return true, nil
	})
}

// Delete deletes the author's message messageID in the room roomID: its text
// is cleared and its reactions removed, and it no longer shows its
// attachments. Deleting it again changes nothing. It fails with ErrNotFound
// or ErrNotAuthor.
func (s *Service) Delete(ctx context.Context, author identity.Visitor, roomID, messageID string) (Message, error) {
	return s.change(ctx, roomID, messageID, func(tx *sql.Tx, m *Message) (bool, error) {
		switch {
		case m.AuthorID != author.ID:
			return false, ErrNotAuthor
		case m.Deleted:
			return false, nil
		}
		now := s.now().UTC().Truncate(time.Millisecond)
		if _, err := tx.ExecContext(ctx, "UPDATE messages SET body = '', deleted_at = ? WHERE id = ?", now.Format(timeLayout), m.ID); err != nil {
			return false, err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM message_reactions WHERE message_id = ?", m.ID); err != nil {
			return false, err
		}
		m.Deleted = true
		return true, nil
	})
}

// React gives reaction to the message messageID in the room roomID as
// visitor when on is true, and takes it back when false; either is a no-op
// when it already holds. It fails with ErrNotFound, ErrInvalidReaction,
// ErrDeleted when giving one to a deleted message, or ErrRateLimited.
func (s *Service) React(ctx context.Context, visitor identity.Visitor, roomID, messageID, reaction string, on bool) (Message, error) {
	if !slices.Contains(Reactions, reaction) {
		return Message{}, ErrInvalidReaction
	}
	return s.change(ctx, roomID, messageID, func(tx *sql.Tx, m *Message) (bool, error) {
		if on && m.Deleted {
			return false, ErrDeleted
		}
		var res sql.Result
		var err error
		if on {
			res, err = tx.ExecContext(ctx, `INSERT INTO message_reactions (message_id, visitor_id, reaction, created_at)
				VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`, m.ID, visitor.ID, reaction, s.now().UTC().Format(timeLayout))
		} else {
			res, err = tx.ExecContext(ctx, "DELETE FROM message_reactions WHERE message_id = ? AND visitor_id = ? AND reaction = ?", m.ID, visitor.ID, reaction)
		}
		if err != nil {
			return false, err
		}
		n, err := res.RowsAffected()
		if err != nil || n == 0 {
			return false, err
		}
		if s.reactLimit != nil && !s.reactLimit.Allow(visitor.ID) {
			return false, ErrRateLimited
		}
		return true, nil
	})
}

// change applies apply to the message messageID of the room roomID in one
// write and, when apply reports a change, publishes the message as it then
// reads, in commit order with new messages.
func (s *Service) change(ctx context.Context, roomID, messageID string, apply func(*sql.Tx, *Message) (bool, error)) (Message, error) {
	var m Message
	changed := false
	s.publishing.Lock()
	defer s.publishing.Unlock()
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		var err error
		m, err = scanMessage(tx.QueryRowContext(ctx, selectMessages+" WHERE id = ? AND room_id = ?", messageID, roomID))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if s.attachments != nil {
			linked, err := s.attachments.ForMessages(ctx, tx, []string{m.ID})
			if err != nil {
				return err
			}
			m.Attachments = append(m.Attachments, linked[m.ID]...)
		}
		if changed, err = apply(tx, &m); err != nil {
			return err
		}
		return decorate(ctx, tx, []*Message{&m})
	})
	for _, known := range []error{ErrNotFound, ErrNotAuthor, ErrDeleted, ErrInvalidBody, ErrRateLimited} {
		if errors.Is(err, known) {
			return Message{}, err
		}
	}
	if err != nil {
		return Message{}, fmt.Errorf("change message: %w", err)
	}
	if changed {
		s.update(m)
	}
	return m, nil
}

func checkReplyTarget(ctx context.Context, tx *sql.Tx, roomID, replyTo string) error {
	var room string
	var deletedAt sql.NullString
	err := tx.QueryRowContext(ctx, "SELECT room_id, deleted_at FROM messages WHERE id = ?", replyTo).Scan(&room, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (room != roomID || deletedAt.Valid)) {
		return ErrInvalidReply
	}
	return err
}

// decorate fills in what messages show beyond their own row: the replies
// they answer and their reactions, and hides what a deleted one no longer
// shows.
func decorate(ctx context.Context, tx *sql.Tx, messages []*Message) error {
	if len(messages) == 0 {
		return nil
	}
	ids := make([]any, 0, len(messages))
	replyIDs := []any{}
	for _, m := range messages {
		ids = append(ids, m.ID)
		if m.replyToID != "" && !m.Deleted {
			replyIDs = append(replyIDs, m.replyToID)
		}
	}
	reactions, err := reactionsOf(ctx, tx, ids)
	if err != nil {
		return err
	}
	replies, err := repliesOf(ctx, tx, replyIDs)
	if err != nil {
		return err
	}
	for _, m := range messages {
		if m.Deleted {
			m.Body, m.ReplyTo = "", nil
			m.Attachments = []attachments.Metadata{}
			m.Reactions = []ReactionGroup{}
			continue
		}
		if r, ok := replies[m.replyToID]; ok {
			m.ReplyTo = &r
		}
		m.Reactions = []ReactionGroup{}
		for _, reaction := range Reactions {
			if who := reactions[m.ID][reaction]; len(who) > 0 {
				m.Reactions = append(m.Reactions, ReactionGroup{Reaction: reaction, VisitorIDs: who})
			}
		}
	}
	return nil
}

func reactionsOf(ctx context.Context, tx *sql.Tx, ids []any) (map[string]map[string][]string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT message_id, reaction, visitor_id FROM message_reactions WHERE message_id IN ("+placeholders(len(ids))+") ORDER BY rowid", ids...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	got := map[string]map[string][]string{}
	for rows.Next() {
		var messageID, reaction, visitorID string
		if err := rows.Scan(&messageID, &reaction, &visitorID); err != nil {
			return nil, err
		}
		if got[messageID] == nil {
			got[messageID] = map[string][]string{}
		}
		got[messageID][reaction] = append(got[messageID][reaction], visitorID)
	}
	return got, rows.Err()
}

func repliesOf(ctx context.Context, tx *sql.Tx, ids []any) (map[string]Reply, error) {
	got := map[string]Reply{}
	if len(ids) == 0 {
		return got, nil
	}
	rows, err := tx.QueryContext(ctx, "SELECT id, author_name, body, deleted_at FROM messages WHERE id IN ("+placeholders(len(ids))+")", ids...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var r Reply
		var body string
		var deletedAt sql.NullString
		if err := rows.Scan(&r.ID, &r.AuthorName, &body, &deletedAt); err != nil {
			return nil, err
		}
		r.Deleted = deletedAt.Valid
		if !r.Deleted {
			r.Excerpt = excerpt(body)
		}
		got[r.ID] = r
	}
	return got, rows.Err()
}

// excerpt is the start of body on one line, cut at excerptLength characters.
func excerpt(body string) string {
	line := strings.Join(strings.Fields(body), " ")
	if utf8.RuneCountInString(line) <= excerptLength {
		return line
	}
	return string([]rune(line)[:excerptLength-1]) + "…"
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}
