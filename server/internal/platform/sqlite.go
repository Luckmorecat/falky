package platform

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// readPoolSize is the number of read connections; writes have one connection.
const readPoolSize = 4

// DB is the SQLite database in WAL mode. All writes go through one writer
// connection, one transaction at a time; reads use a small pool of read-only
// connections and are not blocked by the writer.
type DB struct {
	// path is the database file's absolute path.
	path   string
	writer *sql.DB
	reader *sql.DB
}

// OpenDB opens (creating if needed) the database file at path. The database
// holds secrets, so its file and the WAL and shared-memory files beside it are
// readable and writable by their owner only: a new file is created so, and an
// existing one that others may read or write is made so, with a warning to
// logger.
func OpenDB(ctx context.Context, path string, logger *slog.Logger) (*DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("database path: %w", err)
	}
	f, err := os.OpenFile(abs, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open database %s: %w", abs, err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("open database %s: %w", abs, err)
	}
	// Before SQLite opens them: it gives a WAL or shared-memory file it
	// creates the database file's mode.
	if err := makeOwnerOnly(logger, abs, abs+"-wal", abs+"-shm"); err != nil {
		return nil, fmt.Errorf("open database %s: %w", abs, err)
	}
	writer, err := sql.Open("sqlite", dsn(abs, "immediate",
		"busy_timeout(5000)", "foreign_keys(1)", "journal_mode(WAL)", "synchronous(NORMAL)"))
	if err != nil {
		return nil, fmt.Errorf("open database writer: %w", err)
	}
	writer.SetMaxOpenConns(1)
	var mode string
	if err := writer.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		return nil, errors.Join(fmt.Errorf("open database %s: %w", abs, err), writer.Close())
	}
	if mode != "wal" {
		return nil, errors.Join(fmt.Errorf("open database %s: journal mode is %q, want wal", abs, mode), writer.Close())
	}

	reader, err := sql.Open("sqlite", dsn(abs, "", "busy_timeout(5000)", "foreign_keys(1)", "query_only(1)"))
	if err != nil {
		return nil, errors.Join(fmt.Errorf("open database reader: %w", err), writer.Close())
	}
	reader.SetMaxOpenConns(readPoolSize)
	if err := reader.PingContext(ctx); err != nil {
		return nil, errors.Join(fmt.Errorf("open database reader: %w", err), reader.Close(), writer.Close())
	}
	return &DB{path: abs, writer: writer, reader: reader}, nil
}

// makeOwnerOnly removes the group and other permissions from those of the
// files that have any, and warns once about the ones it changed. Missing files
// are skipped.
func makeOwnerOnly(logger *slog.Logger, paths ...string) error {
	var changed []string
	for _, p := range paths {
		fi, err := os.Stat(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if perm := fi.Mode().Perm(); perm&0o077 != 0 {
			if err := os.Chmod(p, perm&^0o077); err != nil {
				return err
			}
			changed = append(changed, p)
		}
	}
	if len(changed) > 0 {
		logger.Warn("database files were readable or writable by others; made them owner-only", "files", changed)
	}
	return nil
}

func dsn(path, txlock string, pragmas ...string) string {
	q := url.Values{"_pragma": pragmas}
	if txlock != "" {
		q.Set("_txlock", txlock)
	}
	return (&url.URL{Scheme: "file", Path: path, RawQuery: q.Encode()}).String()
}

// Write runs fn in a transaction on the writer connection and commits it when
// fn returns nil. Concurrent calls wait for each other, so transactions commit
// in the order they run.
func (db *DB) Write(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := db.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin write: %w", err)
	}
	if err := fn(tx); err != nil {
		return errors.Join(err, tx.Rollback())
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit write: %w", err)
	}
	return nil
}

// Read returns the read pool. Its connections refuse writes.
func (db *DB) Read() *sql.DB {
	return db.reader
}

// Close closes both the read pool and the writer.
func (db *DB) Close() error {
	return errors.Join(db.reader.Close(), db.writer.Close())
}
