package voice

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
)

// Checking the deadline and reserving a handshake are atomic with expiry.
// Validation probes cannot reserve or extend a lease.
func (s *Service) checkLease(ctx context.Context, g *voiceGrant, reserve bool) error {
	if err := s.storeMu.lock(ctx); err != nil {
		return err
	}
	defer s.storeMu.unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.grants[g.transport] != g || g.revoked || (!g.disconnectedSince.IsZero() && !s.now().Before(g.disconnectedSince.Add(IdleGrace))) {
		return identity.ErrNoVisitor
	}
	if reserve {
		g.pending++
		g.revision++
	}
	return nil
}

func (s *Service) releaseLease(g *voiceGrant) {
	// Release changes only transient bookkeeping and must not wait for a store
	// holder whose request may outlive shutdown. Expiry checks pending and revision
	// together under mu: it either skips the reservation or sees this new revision.
	s.mu.Lock()
	defer s.mu.Unlock()
	g.pending--
	g.revision++
}

func (s *Service) connected(ctx context.Context, g *voiceGrant) error {
	if err := s.storeMu.lock(ctx); err != nil {
		return err
	}
	defer s.storeMu.unlock()
	s.mu.Lock()
	valid := s.grants[g.transport] == g && !g.revoked && g.pending > 0
	s.mu.Unlock()
	if !valid {
		return identity.ErrNoVisitor
	}
	return s.writeLease(ctx, g, time.Time{}, false)
}

// writeLease updates an existing immutable target, never recreating a retired
// grant. Callers hold storeMu and release it before any external effect.
func (s *Service) writeLease(ctx context.Context, g *voiceGrant, since time.Time, revoked bool) error {
	if s.db != nil {
		var value any
		if !since.IsZero() {
			value = since.UnixNano()
		}
		if err := s.db.Write(ctx, func(tx *sql.Tx) error {
			result, err := tx.ExecContext(ctx, `UPDATE voice_grants SET disconnected_since=?,revoked=? WHERE transport=? AND revoked=0`, value, revoked, g.transport)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err == nil && n != 1 {
				return identity.ErrNoVisitor
			}
			return err
		}); err != nil {
			return err
		}
	}
	s.mu.Lock()
	g.disconnectedSince, g.revoked = since, revoked
	g.revision++
	s.mu.Unlock()
	return nil
}

type leaseObservation struct {
	grant    *voiceGrant
	revision uint64
}

func (s *Service) observeLeases(ctx context.Context) ([]leaseObservation, error) {
	grants, err := s.allGrants(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.storeMu.lock(ctx); err != nil {
		return nil, err
	}
	defer s.storeMu.unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	var observations []leaseObservation
	for _, g := range grants {
		if s.grants[g.transport] == g && !g.revoked && g.pending == 0 {
			observations = append(observations, leaseObservation{g, g.revision})
		}
	}
	return observations, nil
}

func (s *Service) reconcileLeases(ctx context.Context, observations []leaseObservation, participants []Participant) ([]*voiceGrant, error) {
	if err := s.storeMu.lock(ctx); err != nil {
		return nil, err
	}
	defer s.storeMu.unlock()
	present := make(map[[2]string]bool)
	for _, p := range participants {
		present[[2]string{p.Identity, p.Room}] = true
	}
	var expired []*voiceGrant
	var result error
	for _, observation := range observations {
		g := observation.grant
		s.mu.Lock()
		current := s.grants[g.transport] == g && !g.revoked && g.pending == 0 && g.revision == observation.revision
		since := g.disconnectedSince
		s.mu.Unlock()
		if !current {
			continue
		}
		revoked := false
		if present[[2]string{g.transport, g.room}] {
			if since.IsZero() {
				continue
			}
			since = time.Time{}
		} else if since.IsZero() {
			since = s.now()
		} else if !s.now().Before(since.Add(IdleGrace)) {
			revoked = true
		} else {
			continue
		}
		if err := s.writeLease(ctx, g, since, revoked); err != nil {
			result = errors.Join(result, err)
			continue
		}
		if revoked {
			expired = append(expired, g)
		}
	}
	return expired, result
}
