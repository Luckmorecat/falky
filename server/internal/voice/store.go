package voice

import (
	"context"
	"database/sql"
	"embed"
	"io/fs"

	"github.com/kisshot/falky/server/internal/platform"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations owns authorization and retryable cleanup, never occupancy.
func Migrations() fs.FS {
	sub, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		panic(err)
	}
	return sub
}

// WithDB makes SQLite authoritative for grants, including after restart.
// Apply Migrations before using the service.
func WithDB(db *platform.DB) Option { return func(s *Service) { s.db = db } }

func (s *Service) allGrants(ctx context.Context) ([]*voiceGrant, error) {
	if err := s.storeMu.lock(ctx); err != nil {
		return nil, err
	}
	defer s.storeMu.unlock()
	if s.db == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		var result []*voiceGrant
		for _, g := range s.grants {
			result = append(result, g)
		}
		return result, nil
	}
	rows, err := s.db.Read().QueryContext(ctx, `SELECT transport,session_id,identity_id,session_kind,generation,room_id,revoked FROM voice_grants ORDER BY transport`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var result []*voiceGrant
	for rows.Next() {
		g := &voiceGrant{sockets: make(map[*signalConnection]struct{})}
		if err := rows.Scan(&g.transport, &g.session.ID, &g.session.Visitor.ID, &g.session.Kind, &g.session.Generation, &g.room, &g.revoked); err != nil {
			return nil, err
		}
		s.mu.Lock()
		if local := s.grants[g.transport]; local != nil {
			local.revoked = g.revoked
			g = local
		} else {
			s.grants[g.transport] = g
		}
		s.mu.Unlock()
		result = append(result, g)
	}
	return result, rows.Err()
}

func (s *Service) grant(ctx context.Context, transport string) (*voiceGrant, error) {
	grants, err := s.allGrants(ctx)
	if err != nil {
		return nil, err
	}
	for _, g := range grants {
		if g.transport == transport {
			return g, nil
		}
	}
	return nil, nil
}

func (s *Service) activeGrant(ctx context.Context, identityID string) (*voiceGrant, error) {
	grants, err := s.allGrants(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, g := range grants {
		if g.session.Visitor.ID == identityID && !g.revoked {
			return g, nil
		}
	}
	return nil, nil
}

func (s *Service) saveGrant(ctx context.Context, g *voiceGrant) error {
	if err := s.storeMu.lock(ctx); err != nil {
		return err
	}
	defer s.storeMu.unlock()
	if s.db != nil {
		if err := s.db.Write(ctx, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `INSERT INTO voice_grants (transport,session_id,identity_id,session_kind,generation,room_id) VALUES (?,?,?,?,?,?)`, g.transport, g.session.ID, g.session.Visitor.ID, g.session.Kind, g.session.Generation, g.room)
			return err
		}); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.grants[g.transport] = g
	s.current[g.session.Visitor.ID] = g.transport
	s.issued[g.session.Visitor.ID] = g.room
	return nil
}
