package platform

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Snapshot writes a consistent copy of the database, as of one moment, to a
// new file at path that only its owner may read or write. It refuses to
// replace an existing file, reporting an error that wraps fs.ErrExist. Writes
// go on while it runs.
func (db *DB) Snapshot(ctx context.Context, path string) (err error) {
	// VACUUM INTO writes into an empty file it finds, keeping its mode.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("snapshot: %w", err)
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, os.Remove(path))
		}
	}()
	if err := f.Close(); err != nil {
		return fmt.Errorf("snapshot: %w", err)
	}
	// On a connection of its own: the writer would hold up writes, and the
	// read pool's connections refuse VACUUM.
	conn, err := sql.Open("sqlite", dsn(db.path, "", "busy_timeout(5000)"))
	if err != nil {
		return fmt.Errorf("snapshot: %w", err)
	}
	_, err = conn.ExecContext(ctx, "VACUUM INTO ?", path)
	if err := errors.Join(err, conn.Close()); err != nil {
		return fmt.Errorf("snapshot: %w", err)
	}
	return nil
}

// ErrBadSnapshot reports a snapshot that Restore refuses: it is damaged, not a
// Falky database, or has migrations the server does not know.
var ErrBadSnapshot = errors.New("bad snapshot")

// Restore makes the snapshot read from r the database at path, for a server
// that is not running. It refuses when a database, or a WAL or shared-memory
// file, is already at path, so nothing of an old database is mixed in. The
// snapshot is checked before it takes the database's place: its integrity,
// and that ms has every migration applied to it (older snapshots are
// migrated when the server starts). It is refused with an error wrapping
// ErrBadSnapshot when it fails a check.
func Restore(ctx context.Context, r io.Reader, path string, ms Migrations) (err error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("database path: %w", err)
	}
	for _, p := range []string{abs, abs + "-wal", abs + "-shm"} {
		if _, err := os.Lstat(p); !errors.Is(err, fs.ErrNotExist) {
			if err != nil {
				return fmt.Errorf("restore: %w", err)
			}
			return fmt.Errorf("%s already exists: restore only into an empty data directory, with the server stopped", p)
		}
	}
	// The snapshot is written and checked beside the database, under a name
	// the server never opens, and linked into place only once it passes.
	f, err := os.CreateTemp(filepath.Dir(abs), filepath.Base(abs)+".restore-*")
	if err != nil {
		return fmt.Errorf("restore: %w", err)
	}
	tmp := f.Name()
	defer func() {
		err = errors.Join(err, removeIfExists(tmp), removeIfExists(tmp+"-wal"), removeIfExists(tmp+"-shm"))
	}()
	_, err = io.Copy(f, r)
	if err := errors.Join(err, f.Sync(), f.Close()); err != nil {
		return fmt.Errorf("restore: read the snapshot: %w", err)
	}
	if err := checkSnapshot(ctx, tmp, ms); err != nil {
		return err
	}
	if err := os.Link(tmp, abs); err != nil {
		return fmt.Errorf("restore: %w", err)
	}
	return nil
}

// checkSnapshot opens the database at path without changing it and checks
// that it is intact and that ms has every migration applied to it.
func checkSnapshot(ctx context.Context, path string, ms Migrations) (err error) {
	conn, err := sql.Open("sqlite", dsn(path, "", "query_only(1)"))
	if err != nil {
		return fmt.Errorf("restore: open the snapshot: %w", err)
	}
	defer func() { err = errors.Join(err, conn.Close()) }()
	rows, err := conn.QueryContext(ctx, "PRAGMA integrity_check")
	if err != nil {
		return fmt.Errorf("%w: the integrity check failed: %w", ErrBadSnapshot, err)
	}
	var problems []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return errors.Join(fmt.Errorf("restore: check the snapshot: %w", err), rows.Close())
		}
		problems = append(problems, line)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return fmt.Errorf("%w: the integrity check failed: %w", ErrBadSnapshot, err)
	}
	if len(problems) != 1 || problems[0] != "ok" {
		return fmt.Errorf("%w: the integrity check failed: %s", ErrBadSnapshot, strings.Join(problems, "; "))
	}

	var hasTable bool
	if err := conn.QueryRowContext(ctx,
		"SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations')",
	).Scan(&hasTable); err != nil {
		return fmt.Errorf("restore: check the snapshot: %w", err)
	}
	if !hasTable {
		return fmt.Errorf("%w: it is not a Falky database (it has no schema_migrations table)", ErrBadSnapshot)
	}
	vrows, err := conn.QueryContext(ctx, "SELECT version, name FROM schema_migrations ORDER BY version")
	if err != nil {
		return fmt.Errorf("restore: check the snapshot: %w", err)
	}
	var unknown []string
	for vrows.Next() {
		var (
			version int
			name    string
		)
		if err := vrows.Scan(&version, &name); err != nil {
			return errors.Join(fmt.Errorf("restore: check the snapshot: %w", err), vrows.Close())
		}
		if !ms.has(version) {
			unknown = append(unknown, name)
		}
	}
	if err := errors.Join(vrows.Err(), vrows.Close()); err != nil {
		return fmt.Errorf("restore: check the snapshot: %w", err)
	}
	if len(unknown) > 0 {
		return fmt.Errorf("%w: it has migrations this falky does not know (%s); it was taken by a newer falky, so restore it with that version",
			ErrBadSnapshot, strings.Join(unknown, ", "))
	}
	return nil
}

func removeIfExists(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
