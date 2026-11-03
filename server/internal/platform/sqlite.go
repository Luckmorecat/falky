package platform

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// readPoolSize is the number of read connections; writes have one connection.
const readPoolSize = 4

// DB is the SQLite database in WAL mode. All writes go through one writer
// connection, one transaction at a time; reads use a small pool of read-only
// connections and are not blocked by the writer.
type DB struct {
	writer *sql.DB
	reader *sql.DB
}

// OpenDB opens (creating if needed) the database file at path.
func OpenDB(ctx context.Context, path string) (*DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("database path: %w", err)
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
	return &DB{writer: writer, reader: reader}, nil
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
