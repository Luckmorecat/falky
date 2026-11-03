package platform

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"strconv"
)

// Migrations is one ordered sequence of schema changes, gathered from the
// modules that own the tables.
type Migrations struct {
	list []migration
}

type migration struct {
	version int
	name    string
	sql     string
}

var migrationFile = regexp.MustCompile(`^(\d+)_[a-z0-9_]+\.sql$`)

// LoadMigrations reads the migration files at the root of each source. A file
// is named <version>_<name>.sql, for example 0001_rooms.sql; versions are
// unique across all sources and are applied in ascending order.
func LoadMigrations(sources ...fs.FS) (Migrations, error) {
	var list []migration
	seen := map[int]string{}
	for _, src := range sources {
		entries, err := fs.ReadDir(src, ".")
		if err != nil {
			return Migrations{}, fmt.Errorf("read migrations: %w", err)
		}
		for _, e := range entries {
			m := migrationFile.FindStringSubmatch(e.Name())
			if e.IsDir() || m == nil {
				return Migrations{}, fmt.Errorf("migration %q: name must be <version>_<name>.sql", e.Name())
			}
			version, err := strconv.Atoi(m[1])
			if err != nil {
				return Migrations{}, fmt.Errorf("migration %q: %w", e.Name(), err)
			}
			if other, ok := seen[version]; ok {
				return Migrations{}, fmt.Errorf("migrations %q and %q share version %d", other, e.Name(), version)
			}
			seen[version] = e.Name()
			body, err := fs.ReadFile(src, e.Name())
			if err != nil {
				return Migrations{}, fmt.Errorf("read migration: %w", err)
			}
			list = append(list, migration{version: version, name: e.Name(), sql: string(body)})
		}
	}
	slices.SortFunc(list, func(a, b migration) int { return a.version - b.version })
	return Migrations{list: list}, nil
}

const createMigrationsTable = `CREATE TABLE IF NOT EXISTS schema_migrations (
	version    INTEGER PRIMARY KEY,
	name       TEXT NOT NULL,
	applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
)`

// Migrate applies the migrations not yet applied, each in its own transaction,
// and returns how many it applied. Running it again applies nothing.
func (db *DB) Migrate(ctx context.Context, ms Migrations) (int, error) {
	if err := db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, createMigrationsTable)
		return err
	}); err != nil {
		return 0, fmt.Errorf("create schema_migrations: %w", err)
	}
	applied := 0
	for _, m := range ms.list {
		ran := false
		err := db.Write(ctx, func(tx *sql.Tx) error {
			var done bool
			if err := tx.QueryRowContext(ctx,
				"SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = ?)", m.version,
			).Scan(&done); err != nil || done {
				return err
			}
			if _, err := tx.ExecContext(ctx, m.sql); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx,
				"INSERT INTO schema_migrations (version, name) VALUES (?, ?)", m.version, m.name,
			); err != nil {
				return err
			}
			ran = true
			return nil
		})
		if err != nil {
			return applied, fmt.Errorf("migration %s: %w", m.name, err)
		}
		if ran {
			applied++
		}
	}
	return applied, nil
}

// ErrNotMigrated reports that the database lacks migrations the server needs.
var ErrNotMigrated = errors.New("database is not migrated")

// CheckMigrated returns nil when every migration in ms is applied, and
// ErrNotMigrated when one is not.
func (db *DB) CheckMigrated(ctx context.Context, ms Migrations) error {
	var hasTable bool
	if err := db.reader.QueryRowContext(ctx,
		"SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations')",
	).Scan(&hasTable); err != nil {
		return fmt.Errorf("check migrations: %w", err)
	}
	if !hasTable {
		return ErrNotMigrated
	}
	versions := make([]int, len(ms.list))
	for i, m := range ms.list {
		versions[i] = m.version
	}
	known, err := json.Marshal(versions)
	if err != nil {
		return fmt.Errorf("check migrations: %w", err)
	}
	var pending int
	if err := db.reader.QueryRowContext(ctx,
		"SELECT count(*) FROM json_each(?) WHERE value NOT IN (SELECT version FROM schema_migrations)", string(known),
	).Scan(&pending); err != nil {
		return fmt.Errorf("check migrations: %w", err)
	}
	if pending > 0 {
		return ErrNotMigrated
	}
	return nil
}
