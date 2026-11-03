package platform

import (
	"database/sql"
	"errors"
	"io/fs"
	"path/filepath"
	"sync"
	"testing"
	"testing/fstest"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := OpenDB(t.Context(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return db
}

func TestOpenDBUsesWALOnBothPools(t *testing.T) {
	db := openTestDB(t)
	for name, pool := range map[string]*sql.DB{"writer": db.writer, "reader": db.Read()} {
		var mode string
		if err := pool.QueryRowContext(t.Context(), "PRAGMA journal_mode").Scan(&mode); err != nil {
			t.Fatalf("%s: journal_mode: %v", name, err)
		}
		if mode != "wal" {
			t.Errorf("%s: journal_mode = %q, want wal", name, mode)
		}
	}
}

func TestWritesGoThroughOneWriterConnection(t *testing.T) {
	db := openTestDB(t)
	if got := db.writer.Stats().MaxOpenConnections; got != 1 {
		t.Fatalf("writer MaxOpenConnections = %d, want 1", got)
	}
	ctx := t.Context()
	if err := db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "CREATE TABLE t (n INTEGER NOT NULL)")
		return err
	}); err != nil {
		t.Fatalf("create table: %v", err)
	}

	// Concurrent writers queue on the single connection instead of failing
	// with SQLITE_BUSY.
	const writers = 20
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := range writers {
		wg.Go(func() {
			errs <- db.Write(ctx, func(tx *sql.Tx) error {
				_, err := tx.ExecContext(ctx, "INSERT INTO t (n) VALUES (?)", i)
				return err
			})
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent write: %v", err)
		}
	}
	var count int
	if err := db.Read().QueryRowContext(ctx, "SELECT count(*) FROM t").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != writers {
		t.Errorf("rows = %d, want %d", count, writers)
	}
}

func TestReadPoolRefusesWrites(t *testing.T) {
	db := openTestDB(t)
	if _, err := db.Read().ExecContext(t.Context(), "CREATE TABLE t (n INTEGER)"); err == nil {
		t.Fatal("write through the read pool succeeded, want an error")
	}
}

func TestWriteRollsBackWhenFnFails(t *testing.T) {
	db := openTestDB(t)
	ctx := t.Context()
	failure := errors.New("fn failed")
	err := db.Write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "CREATE TABLE t (n INTEGER)"); err != nil {
			return err
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatalf("Write = %v, want the fn's error", err)
	}
	var n int
	if err := db.Read().QueryRowContext(ctx,
		"SELECT count(*) FROM sqlite_schema WHERE name = 't'").Scan(&n); err != nil {
		t.Fatalf("query schema: %v", err)
	}
	if n != 0 {
		t.Error("table exists after a failed Write, want it rolled back")
	}
}

func TestMigrateAppliesEachMigrationOnce(t *testing.T) {
	db := openTestDB(t)
	ctx := t.Context()
	ms, err := LoadMigrations(
		fstest.MapFS{"0002_notes.sql": {Data: []byte("CREATE TABLE notes (id INTEGER PRIMARY KEY, thing_id INTEGER REFERENCES things(id));")}},
		fstest.MapFS{"0001_things.sql": {Data: []byte("CREATE TABLE things (id INTEGER PRIMARY KEY);\nCREATE INDEX things_id ON things (id);")}},
	)
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	if err := db.CheckMigrated(ctx, ms); err == nil {
		t.Fatal("CheckMigrated before Migrate = nil, want an error")
	}

	applied, err := db.Migrate(ctx, ms)
	if err != nil {
		t.Fatalf("first Migrate: %v", err)
	}
	if applied != 2 {
		t.Errorf("first Migrate applied %d, want 2", applied)
	}
	applied, err = db.Migrate(ctx, ms)
	if err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
	if applied != 0 {
		t.Errorf("second Migrate applied %d, want 0", applied)
	}
	if err := db.CheckMigrated(ctx, ms); err != nil {
		t.Errorf("CheckMigrated after Migrate: %v", err)
	}
	for _, table := range []string{"things", "notes"} {
		var n int
		if err := db.Read().QueryRowContext(ctx,
			"SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?", table).Scan(&n); err != nil {
			t.Fatalf("query schema: %v", err)
		}
		if n != 1 {
			t.Errorf("table %s missing after Migrate", table)
		}
	}
}

func TestMigrateStopsAtAFailingMigration(t *testing.T) {
	db := openTestDB(t)
	ctx := t.Context()
	ms, err := LoadMigrations(fstest.MapFS{
		"0001_ok.sql":     {Data: []byte("CREATE TABLE ok (id INTEGER);")},
		"0002_broken.sql": {Data: []byte("CREATE TABLE broken (id INTEGER); NOT SQL;")},
	})
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	applied, err := db.Migrate(ctx, ms)
	if err == nil {
		t.Fatal("Migrate = nil, want the broken migration's error")
	}
	if applied != 1 {
		t.Errorf("applied %d, want 1", applied)
	}
	var n int
	if err := db.Read().QueryRowContext(ctx,
		"SELECT count(*) FROM sqlite_schema WHERE name = 'broken'").Scan(&n); err != nil {
		t.Fatalf("query schema: %v", err)
	}
	if n != 0 {
		t.Error("broken migration left its table behind, want it rolled back")
	}
	if err := db.CheckMigrated(ctx, ms); err == nil {
		t.Error("CheckMigrated = nil with a migration missing, want an error")
	}
}

func TestLoadMigrationsRefusesBadSources(t *testing.T) {
	for name, sources := range map[string][]fs.FS{
		"duplicate version": {
			fstest.MapFS{"0001_a.sql": {Data: []byte("SELECT 1;")}},
			fstest.MapFS{"0001_b.sql": {Data: []byte("SELECT 1;")}},
		},
		"bad name": {
			fstest.MapFS{"init.sql": {Data: []byte("SELECT 1;")}},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadMigrations(sources...); err == nil {
				t.Error("LoadMigrations = nil error, want a refusal")
			}
		})
	}
}
