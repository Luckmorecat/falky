package attachments

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"time"
)

// Queryer is shared by a read pool, a read transaction and chat's write transaction.
type Queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (s *Store) ForMessages(ctx context.Context, q Queryer, ids []string) (map[string][]Metadata, error) {
	out := map[string][]Metadata{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, len(ids))
	marks := make([]string, len(ids))
	for i, id := range ids {
		args[i] = id
		marks[i] = "?"
	}
	rows, err := q.QueryContext(ctx, `SELECT `+columns+` FROM attachments WHERE message_id IN (`+strings.Join(marks, ",")+`) ORDER BY message_id,position`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		r, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out[r.message.String] = append(out[r.message.String], r.Metadata)
	}
	return out, rows.Err()
}

// Consume runs only within the caller's write transaction, under LockPost.
// It validates every draft and quota feasibility before changing any victim.
func (s *Store) Consume(ctx context.Context, tx *sql.Tx, owner, room, message string, ids []string) ([]Metadata, []Expiry, error) {
	if len(ids) > MaxAttachments {
		return nil, nil, ErrInvalidAttachments
	}
	out := make([]Metadata, 0, len(ids))
	seen := map[string]bool{}
	var total int64
	for _, id := range ids {
		if seen[id] {
			return nil, nil, ErrInvalidAttachments
		}
		seen[id] = true
		r, err := scan(tx.QueryRowContext(ctx, `SELECT `+columns+` FROM attachments WHERE id=?`, id))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, ErrInvalidAttachments
		}
		if err != nil {
			return nil, nil, err
		}
		if r.owner != owner || r.RoomID != room || r.state != "ready" || !r.ExpiresAt.After(s.now()) {
			return nil, nil, ErrInvalidAttachments
		}
		info, err := os.Stat(s.path(id, ".data"))
		if err != nil || !info.Mode().IsRegular() || info.Size() != r.Size {
			return nil, nil, ErrInvalidAttachments
		}
		total += r.Size
		r.Availability = "posted"
		r.ExpiresAt = time.Time{}
		out = append(out, r.Metadata)
	}
	if total > s.limits.PostedBytes {
		return nil, nil, ErrQuota
	}
	if len(ids) == 0 {
		return out, nil, nil
	}
	var debt bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM attachments WHERE (cleanup=1 AND allocation='posted') OR (state='posted' AND allocation='staging'))`).Scan(&debt); err != nil {
		return nil, nil, err
	}
	if debt {
		return nil, nil, ErrCleanupPending
	}
	var used int64
	if err := tx.QueryRowContext(ctx, `SELECT coalesce(sum(reserved),0) FROM attachments WHERE allocation='posted'`).Scan(&used); err != nil {
		return nil, nil, err
	}
	var victims []record
	if used > s.limits.PostedBytes-total {
		rows, err := tx.QueryContext(ctx, `SELECT `+columns+` FROM attachments WHERE state='posted' ORDER BY message_id,position`)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			r, err := scan(rows)
			if err != nil {
				_ = rows.Close()
				return nil, nil, err
			}
			victims = append(victims, r)
			used -= r.reserved
			if used <= s.limits.PostedBytes-total {
				break
			}
		}
		if err = errors.Join(rows.Err(), rows.Close()); err != nil {
			return nil, nil, err
		}
		if used > s.limits.PostedBytes-total {
			return nil, nil, ErrQuota
		}
	}
	events := make([]Expiry, 0, len(victims))
	for _, r := range victims {
		if _, err := tx.ExecContext(ctx, `UPDATE attachments SET state='expired',cleanup=1 WHERE id=?`, r.ID); err != nil {
			return nil, nil, err
		}
		events = append(events, Expiry{RoomID: r.RoomID, IDs: []string{r.ID}})
	}
	for pos, id := range ids {
		if _, err := tx.ExecContext(ctx, `UPDATE attachments SET state='posted',expires_at=0,message_id=?,position=? WHERE id=?`, message, pos, id); err != nil {
			return nil, nil, err
		}
	}
	return out, events, nil
}
