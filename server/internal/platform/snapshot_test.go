package platform

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// testMigrations creates the table of things the tests count.
var testMigrations = fstest.MapFS{"0001_things.sql": {Data: []byte("CREATE TABLE things (n INTEGER NOT NULL);")}}

// openMigratedTestDB opens a new database at path with testMigrations applied.
func openMigratedTestDB(t *testing.T, path string) (*DB, Migrations) {
	t.Helper()
	ms, err := LoadMigrations(testMigrations)
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	db, err := OpenDB(t.Context(), path, NewLogger(io.Discard, 0))
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
	return db, ms
}

func insertThing(ctx context.Context, db *DB, n int) error {
	return db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO things (n) VALUES (?)", n)
		return err
	})
}

func countThings(t *testing.T, db *DB) int {
	t.Helper()
	var n int
	if err := db.Read().QueryRowContext(t.Context(), "SELECT count(*) FROM things").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// takeSnapshot snapshots db into a new file in a new directory.
func takeSnapshot(t *testing.T, db *DB) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "snapshot.db")
	if err := db.Snapshot(t.Context(), path); err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	return path
}

func wantMode(t *testing.T, path string, want fs.FileMode) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if got := fi.Mode().Perm(); got != want {
		t.Errorf("%s mode = %v, want %v", filepath.Base(path), got, want)
	}
}

func TestASnapshotIsAnOwnerOnlyCopyOfOneMomentWhileWritesGoOn(t *testing.T) {
	dir := t.TempDir()
	db, ms := openMigratedTestDB(t, filepath.Join(dir, "falky.db"))
	ctx := t.Context()
	for i := range 100 {
		if err := insertThing(ctx, db, i); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}

	stop := make(chan struct{})
	written := make(chan int)
	go func() {
		n := 100
		defer func() { written <- n }()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if err := insertThing(ctx, db, n); err != nil {
				t.Errorf("insert while snapshotting: %v", err)
				return
			}
			n++
		}
	}()
	path := takeSnapshot(t, db)
	close(stop)
	total := <-written
	wantMode(t, path, 0o600)
	wantOnly(t, filepath.Dir(path), "snapshot.db")

	snap, err := OpenDB(ctx, path, NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatalf("open the snapshot: %v", err)
	}
	t.Cleanup(func() {
		if err := snap.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	if err := snap.CheckMigrated(ctx, ms); err != nil {
		t.Errorf("CheckMigrated on the snapshot: %v", err)
	}
	// One moment: the rows are 0..n-1, with nothing missing in between.
	var count, maxN int
	if err := snap.Read().QueryRowContext(ctx, "SELECT count(*), max(n) FROM things").Scan(&count, &maxN); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count < 100 || count > total || maxN != count-1 {
		t.Errorf("snapshot has %d rows up to %d, want 100..%d rows numbered from 0 without gaps", count, maxN, total)
	}
	if got := countThings(t, db); got != total {
		t.Errorf("database has %d rows after the snapshot, want all %d written", got, total)
	}
}

func TestASnapshotNeverReplacesAFile(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, "falky.db")
	db, _ := openMigratedTestDB(t, live)
	earlier := filepath.Join(dir, "earlier.db")
	if err := os.WriteFile(earlier, []byte("earlier"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	for name, path := range map[string]string{"the live database": live, "an earlier snapshot": earlier} {
		t.Run(name, func(t *testing.T) {
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("ReadFile: %v", err)
			}
			if err := db.Snapshot(t.Context(), path); !errors.Is(err, fs.ErrExist) {
				t.Errorf("Snapshot = %v, want an error wrapping fs.ErrExist", err)
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("ReadFile after: %v", err)
			}
			if !bytes.Equal(before, after) {
				t.Error("Snapshot changed the file")
			}
		})
	}
}

// restoreFrom restores the file at snapshot into a new data directory and
// returns the database path.
func restoreFrom(t *testing.T, snapshot string, ms Migrations) (string, error) {
	t.Helper()
	f, err := os.Open(snapshot)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	}()
	path := filepath.Join(t.TempDir(), "falky.db")
	return path, Restore(t.Context(), f, path, ms)
}

// wantOnly fails unless dir holds exactly the files named.
func wantOnly(t *testing.T, dir string, names ...string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if strings.Join(got, ",") != strings.Join(names, ",") {
		t.Errorf("%s holds %q, want %q", dir, got, names)
	}
}

func TestARestoredSnapshotIsTheDatabase(t *testing.T) {
	db, ms := openMigratedTestDB(t, filepath.Join(t.TempDir(), "falky.db"))
	for i := range 3 {
		if err := insertThing(t.Context(), db, i); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}
	snapshot := takeSnapshot(t, db)

	path, err := restoreFrom(t, snapshot, ms)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	wantOnly(t, filepath.Dir(path), "falky.db")
	wantMode(t, path, 0o600)
	restored, _ := openMigratedTestDB(t, path)
	if got := countThings(t, restored); got != 3 {
		t.Errorf("restored database has %d rows, want 3", got)
	}
}

func TestRestoreRefusesADataDirectoryInUse(t *testing.T) {
	db, ms := openMigratedTestDB(t, filepath.Join(t.TempDir(), "falky.db"))
	snapshot := takeSnapshot(t, db)
	for _, leftover := range []string{"falky.db", "falky.db-wal", "falky.db-shm"} {
		t.Run(leftover, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, leftover), []byte("old"), 0o600); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}
			f, err := os.Open(snapshot)
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			defer func() { _ = f.Close() }()
			err = Restore(t.Context(), f, filepath.Join(dir, "falky.db"), ms)
			if err == nil || !strings.Contains(err.Error(), leftover) {
				t.Errorf("Restore = %v, want a refusal naming %s", err, leftover)
			}
			wantOnly(t, dir, leftover)
			if b, err := os.ReadFile(filepath.Join(dir, leftover)); err != nil || string(b) != "old" {
				t.Errorf("%s = %q, %v; want it untouched", leftover, b, err)
			}
		})
	}
}

func TestRestoreRefusesBadSnapshots(t *testing.T) {
	db, ms := openMigratedTestDB(t, filepath.Join(t.TempDir(), "falky.db"))
	for i := range 2000 {
		if err := insertThing(t.Context(), db, i); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}
	good, err := os.ReadFile(takeSnapshot(t, db))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	newer, err := LoadMigrations(testMigrations, fstest.MapFS{"0002_more.sql": {Data: []byte("CREATE TABLE more (n INTEGER);")}})
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	newerDB, err := OpenDB(t.Context(), filepath.Join(t.TempDir(), "newer.db"), NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() { _ = newerDB.Close() })
	if _, err := newerDB.Migrate(t.Context(), newer); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	newerSnapshot, err := os.ReadFile(takeSnapshot(t, newerDB))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	plainDB, err := OpenDB(t.Context(), filepath.Join(t.TempDir(), "plain.db"), NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() { _ = plainDB.Close() })
	if err := plainDB.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), "CREATE TABLE notes (body TEXT)")
		return err
	}); err != nil {
		t.Fatalf("create table: %v", err)
	}
	plainSnapshot, err := os.ReadFile(takeSnapshot(t, plainDB))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	// A page in the middle of the table, overwritten with garbage.
	corrupt := bytes.Clone(good)
	copy(corrupt[len(corrupt)/2:], bytes.Repeat([]byte{0xa5}, 4096))

	for name, tc := range map[string]struct {
		snapshot []byte
		want     string
	}{
		"empty":                {nil, "not a Falky database"},
		"not SQLite":           {[]byte(strings.Repeat("not a database ", 512)), "integrity check failed"},
		"truncated":            {good[:len(good)/2], "integrity check failed"},
		"corrupt":              {corrupt, "integrity check failed"},
		"not a Falky database": {plainSnapshot, "not a Falky database"},
		"from a newer falky":   {newerSnapshot, "0002_more.sql"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			err := Restore(t.Context(), bytes.NewReader(tc.snapshot), filepath.Join(dir, "falky.db"), ms)
			if !errors.Is(err, ErrBadSnapshot) || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Restore = %v, want ErrBadSnapshot saying %q", err, tc.want)
			}
			wantOnly(t, dir)
		})
	}
}

func TestOpeningADatabaseOthersCanReadMakesItOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "falky.db")
	db, _ := openMigratedTestDB(t, path)
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE, 0o600)
		if err != nil {
			t.Fatalf("OpenFile: %v", err)
		}
		if err := errors.Join(f.Close(), os.Chmod(p, 0o644)); err != nil {
			t.Fatalf("make %s readable by others: %v", p, err)
		}
	}

	var logs bytes.Buffer
	reopened, err := OpenDB(t.Context(), path, NewLogger(&logs, 0))
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	if err := reopened.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		if _, err := os.Stat(p); err == nil {
			wantMode(t, p, 0o600)
		}
	}
	if n := strings.Count(logs.String(), `"level":"WARN"`); n != 1 || !strings.Contains(logs.String(), path+"-shm") {
		t.Errorf("logs = %q, want one warning naming the files", logs.String())
	}

	logs.Reset()
	again, err := OpenDB(t.Context(), path, NewLogger(&logs, 0))
	if err != nil {
		t.Fatalf("OpenDB again: %v", err)
	}
	if err := again.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
	if logs.Len() != 0 {
		t.Errorf("logs on reopening = %q, want none", logs.String())
	}
}
