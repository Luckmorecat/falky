package identity

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"maps"
	"slices"
)

var palettes = []string{"sky", "apricot", "lagoon", "rose", "violet", "amber", "moss", "coral", "indigo", "plum", "sunset", "aurora", "lime", "clay", "ocean", "ruby"}

// Colour is a visitor's persistent assignment. Revisions order accepted saves,
// independently of HTTP responses, event delivery and server restarts.
type Colour struct {
	VisitorID string
	Palette   string
	Revision  int64
}

// ErrInvalidPalette reports a palette outside the shared set of sixteen.
var ErrInvalidPalette = errors.New("invalid palette")

// WithColourChoice replaces the uniform random candidate index selection.
// choose must return an index in [0,n); this seam permits deterministic tests.
func WithColourChoice(choose func(n int) int) Option {
	return func(s *Service) { s.chooseColour = choose }
}

// ColourConnected records actual first-open/last-close live connection lifetime.
// The hub invokes this under its lock. It only updates private memory: it never
// accesses the database or publishes, and no database operation holds colourMu.
func (s *Service) ColourConnected(visitorID string, connected bool) {
	s.colourMu.Lock()
	defer s.colourMu.Unlock()
	if connected {
		s.connected[visitorID] = true
	} else {
		delete(s.connected, visitorID)
	}
}

// InitializeColours assigns every historical identity once before serving,
// including visitors whose tokens have been revoked. Failures abort startup.
// It is safe to run again and requires only identity's migrations.
func (s *Service) InitializeColours(ctx context.Context) error {
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT v.id FROM identities v LEFT JOIN profiles c ON c.identity_id = v.id WHERE c.identity_id IS NULL ORDER BY v.id`)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = errors.Join(rows.Err(), rows.Close())
		if err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := s.allocateColour(ctx, tx, id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("initialize visitor colours: %w", err)
	}
	return nil
}

// allocateColour runs inside the same writer transaction that creates a visitor.
// No assignments change between reading them and sampling. Connection membership
// is sampled under its short memory lock, so extra tabs never weight a visitor.
func (s *Service) allocateColour(ctx context.Context, tx *sql.Tx, id string) (Colour, error) {
	rows, err := tx.QueryContext(ctx, "SELECT identity_id, palette FROM profiles")
	if err != nil {
		return Colour{}, err
	}
	type assignment struct{ id, palette string }
	var assigned []assignment
	used := make(map[string]int)
	for rows.Next() {
		var a assignment
		if err := rows.Scan(&a.id, &a.palette); err != nil {
			_ = rows.Close()
			return Colour{}, err
		}
		assigned = append(assigned, a)
		used[a.palette]++
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return Colour{}, err
	}
	connected := make(map[string]int)
	s.colourMu.Lock()
	live := maps.Clone(s.connected)
	s.colourMu.Unlock()
	for _, a := range assigned {
		if live[a.id] {
			connected[a.palette]++
		}
	}
	candidates := make([]string, 0, len(palettes))
	for _, p := range palettes {
		if used[p] == 0 {
			candidates = append(candidates, p)
		}
	}
	if len(candidates) == 0 {
		least := int(^uint(0) >> 1)
		for _, p := range palettes {
			least = min(least, connected[p])
		}
		for _, p := range palettes {
			if connected[p] == least {
				candidates = append(candidates, p)
			}
		}
	}
	c := Colour{VisitorID: id, Palette: candidates[s.chooseColour(len(candidates))], Revision: 1}
	_, err = tx.ExecContext(ctx, "INSERT INTO profiles (identity_id, palette, revision) VALUES (?, ?, ?)", c.VisitorID, c.Palette, c.Revision)
	return c, err
}

// SetColour saves an explicit palette, including duplicates. Every accepted
// save increments revision even when the palette is unchanged. Publish only
// after this returns: hub callbacks must never run under a database transaction.
func (s *Service) SetColour(ctx context.Context, visitorID, palette string) (Colour, error) {
	if !slices.Contains(palettes, palette) {
		return Colour{}, ErrInvalidPalette
	}
	c := Colour{VisitorID: visitorID, Palette: palette}
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `UPDATE profiles SET palette = ?, revision = revision + 1 WHERE identity_id = ? RETURNING revision`, palette, visitorID).Scan(&c.Revision)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Colour{}, ErrNoVisitor
	}
	if err != nil {
		return Colour{}, fmt.Errorf("save visitor colour: %w", err)
	}
	return c, nil
}

// Colours looks up explicit existing IDs, including historical identities. It
// grants no access and omits unknown IDs; it never creates phantom visitors.
func (s *Service) Colours(ctx context.Context, visitorIDs []string) ([]Colour, error) {
	result := make([]Colour, 0, len(visitorIDs))
	seen := make(map[string]bool)
	for _, id := range visitorIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		c := Colour{VisitorID: id}
		err := s.db.Read().QueryRowContext(ctx, "SELECT palette, revision FROM profiles WHERE identity_id = ?", id).Scan(&c.Palette, &c.Revision)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("look up visitor colour: %w", err)
		}
		result = append(result, c)
	}
	return result, nil
}
