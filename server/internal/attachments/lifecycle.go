package attachments

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Store) cleanupLocked(ctx context.Context) error {
	rows, err := s.db.Read().QueryContext(ctx, `SELECT id FROM attachments WHERE cleanup=1`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return err
	}
	var failures error
	for _, id := range ids {
		var failure error
		for _, suffix := range []string{".source", ".work", ".data"} {
			failure = errors.Join(failure, s.unlink(s.path(id, suffix)))
		}
		if failure != nil {
			failures = errors.Join(failures, failure)
			continue
		}
		if err = syncFile(s.root); err != nil {
			failures = errors.Join(failures, err)
			continue
		}
		if err = s.db.Write(ctx, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `UPDATE attachments SET cleanup=0,allocation='none',reserved=0 WHERE id=? AND cleanup=1`, id)
			return err
		}); err != nil {
			failures = errors.Join(failures, err)
		}
	}
	if failures != nil {
		return failures
	}
	// Newly posted bytes stay charged to staging until old posted bytes have
	// physically gone. Failed unlink cannot manufacture free posted quota.
	return s.db.Write(ctx, func(tx *sql.Tx) error {
		var posted, pending int64
		if err := tx.QueryRowContext(ctx, `SELECT coalesce(sum(CASE WHEN allocation='posted' THEN reserved ELSE 0 END),0),coalesce(sum(CASE WHEN state='posted' AND allocation='staging' THEN reserved ELSE 0 END),0) FROM attachments`).Scan(&posted, &pending); err != nil {
			return err
		}
		if pending > 0 && posted > s.limits.PostedBytes-pending {
			return ErrCleanupPending
		}
		_, err := tx.ExecContext(ctx, `UPDATE attachments SET allocation='posted' WHERE state='posted' AND allocation='staging'`)
		return err
	})
}

// Recover reconciles durable state before serving and periodically afterwards.
// Live incoming objects are excluded so sweeps can run during uploads.
func (s *Store) Recover(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Read().QueryContext(ctx, `SELECT `+columns+` FROM attachments`)
	if err != nil {
		return err
	}
	var records []record
	for rows.Next() {
		r, scanErr := scan(rows)
		if scanErr != nil {
			err = scanErr
			break
		}
		records = append(records, r)
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for _, r := range records {
		known[r.ID] = true
		if s.active[r.ID] {
			continue
		}
		expire := r.state == "incoming" || (r.state == "ready" && !r.ExpiresAt.After(s.now()))
		if r.state == "ready" || r.state == "posted" {
			_, err := os.Stat(s.path(r.ID, ".data"))
			if errors.Is(err, fs.ErrNotExist) {
				expire = true
			} else if err != nil {
				return err
			}
		}
		if expire {
			if err = s.db.Write(ctx, func(tx *sql.Tx) error {
				_, err := tx.ExecContext(ctx, `UPDATE attachments SET state='expired',cleanup=1 WHERE id=?`, r.ID)
				return err
			}); err != nil {
				return err
			}
			if r.message.Valid {
				s.publish(Expiry{RoomID: r.RoomID, IDs: []string{r.ID}})
			}
		}
	}
	if err = s.cleanupLocked(ctx); err != nil {
		return err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !objectName.MatchString(entry.Name()) {
			continue
		}
		id := strings.SplitN(entry.Name(), ".", 2)[0]
		if known[id] {
			continue
		}
		if err = s.unlink(filepath.Join(s.root, entry.Name())); err != nil {
			return err
		}
	}
	return syncFile(s.root)
}

// Run retries durable cleanup and expires drafts until ctx is cancelled.
func (s *Store) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Recover(ctx); err != nil {
				s.report(err)
			}
		}
	}
}

// Close stops admission and cancels processing. The HTTP owner must also stop
// request readers so blocked Reads return before shutdown can complete.
func (s *Store) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	done := make(chan struct{})
	go func() { s.workers.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// LockPost holds lifecycle operations across a chat write and its committed
// filesystem effects. Release it even if the write rolls back.
func (s *Store) LockPost() func() { s.mu.Lock(); return s.mu.Unlock }

// Committed applies effects after SQL commit, while LockPost is held. Cleanup
// failure stays durable and must never turn a committed message into an error.
func (s *Store) Committed(expiries []Expiry) {
	if err := s.cleanupLocked(context.Background()); err != nil {
		s.report(err)
	}
	for _, event := range expiries {
		s.publish(event)
	}
}
