package voice

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/kisshot/falky/server/internal/rooms"

	"github.com/kisshot/falky/server/internal/identity"
)

type voiceGrant struct {
	session           identity.Session
	transport, room   string
	revoked           bool
	disconnectedSince time.Time
	revision          uint64
	pending           int
	sockets           map[*signalConnection]struct{}
}

// ConfigureAdmission must run before serving. One gate protects identity
// mutations, token issuance, and the complete signalling handshake.
func (s *Service) ConfigureAdmission(gate sync.Locker, validate func(context.Context, identity.Session) (identity.Session, error), publicOrigin string) {
	s.admission, s.validate = gate, validate
	s.guardedURL = "ws" + strings.TrimPrefix(publicOrigin, "http")
}

func (s *Service) fence(ctx context.Context, g *voiceGrant) error {
	if err := s.storeMu.lock(ctx); err != nil {
		return err
	}
	defer s.storeMu.unlock()
	if s.db != nil {
		if err := s.db.Write(ctx, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `UPDATE voice_grants SET revoked=1 WHERE transport=?`, g.transport)
			return err
		}); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	g.revoked = true
	g.revision++
	return nil
}

func (s *Service) closeGrant(ctx context.Context, g *voiceGrant) {
	s.mu.Lock()
	var sockets []*signalConnection
	for socket := range g.sockets {
		sockets = append(sockets, socket)
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	for _, socket := range sockets {
		socket.revoke(ctx)
	}
}

func (s *Service) retire(ctx context.Context, g *voiceGrant) error {
	if err := s.storeMu.lock(ctx); err != nil {
		return err
	}
	defer s.storeMu.unlock()
	if s.db != nil {
		if err := s.db.Write(ctx, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `DELETE FROM voice_grants WHERE transport=? AND revoked=1`, g.transport)
			return err
		}); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.grants, g.transport)
	return nil
}

func (s *Service) removeGrant(ctx context.Context, g *voiceGrant) error {
	removalCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := s.livekit.RemoveParticipant(removalCtx, g.room, g.transport); err != nil {
		return err
	}
	return s.retire(ctx, g)
}

// Revoke durably fences all matches and closes every local socket before any
// media call. Callers serialize it with admission through the lifecycle gate.
func (s *Service) Revoke(ctx context.Context, matches func(identity.Session) bool) error {
	if err := s.FenceSessions(ctx, matches); err != nil {
		return err
	}
	return s.CleanupGrants(ctx)
}

// FenceSessions is the local part of Revoke, for composing lifecycle work.
// Its caller holds the admission gate. It performs no external media calls.
func (s *Service) FenceSessions(ctx context.Context, matches func(identity.Session) bool) error {
	grants, err := s.allGrants(ctx)
	if err != nil {
		return err
	}
	for _, g := range grants {
		if matches(g.session) {
			if e := s.fence(ctx, g); e != nil {
				err = errors.Join(err, e)
				continue
			}
			s.closeGrant(ctx, g)
		}
	}
	return err
}

// ValidateGrants is maintenance's local phase. The lifecycle gate must be held.
// It validates even absent participants, durably fences invalid grants, and
// closes local signaling before returning. It makes no LiveKit calls.
func (s *Service) ValidateGrants(ctx context.Context) error {
	grants, err := s.allGrants(ctx)
	if err != nil {
		return err
	}
	for _, g := range grants {
		s.mu.Lock()
		revoked := g.revoked
		s.mu.Unlock()
		if !revoked {
			if _, checkErr := s.authorizeGrant(ctx, g); checkErr != nil {
				if !errors.Is(checkErr, identity.ErrNoVisitor) && !errors.Is(checkErr, identity.ErrNameTaken) && !errors.Is(checkErr, rooms.ErrNotFound) {
					err = errors.Join(err, checkErr)
					continue
				}
				if e := s.fence(ctx, g); e != nil {
					err = errors.Join(err, e)
					continue
				}
				revoked = true
			}
		}
		if revoked {
			s.closeGrant(ctx, g)
		}
	}
	return err
}

// CleanupGrants is maintenance's external phase, after all live/voice local
// closures. Revoked records are retried independently of participant listings.
// Do not hold the lifecycle gate, hub locks, or a DB transaction across it.
func (s *Service) CleanupGrants(ctx context.Context) error {
	grants, err := s.allGrants(ctx)
	if err != nil {
		return err
	}
	return errors.Join(s.cleanupGrants(ctx, grants), s.Refresh(ctx))
}

func (s *Service) cleanupGrants(ctx context.Context, grants []*voiceGrant) error {
	var err error
	var running sync.WaitGroup
	var resultMu sync.Mutex
	for _, g := range grants {
		s.mu.Lock()
		revoked := g.revoked
		s.mu.Unlock()
		if !revoked {
			continue
		}
		running.Go(func() {
			removalErr := s.removeGrant(ctx, g)
			resultMu.Lock()
			err = errors.Join(err, removalErr)
			resultMu.Unlock()
		})
	}
	running.Wait()
	return err
}

// CloseSignalling ends all proxied sockets during server shutdown.
func (s *Service) CloseSignalling() {
	s.mu.Lock()
	var sockets []*signalConnection
	for _, g := range s.grants {
		for socket := range g.sockets {
			sockets = append(sockets, socket)
		}
	}
	s.mu.Unlock()
	for _, socket := range sockets {
		socket.close()
	}
}
