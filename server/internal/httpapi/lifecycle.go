package httpapi

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/voice"

	"github.com/kisshot/falky/server/internal/identity"
)

// Lifecycle serializes access mutations with final live and voice admission.
// Enforce runs after commit while the gate is held; successful enforcement
// finishes required disconnects before returning. Configure it before serving.
type Lifecycle struct {
	once    sync.Once
	gate    chan struct{}
	Enforce func(context.Context, identity.Effects) error
}

func (l *Lifecycle) semaphore() chan struct{} {
	l.once.Do(func() { l.gate = make(chan struct{}, 1) })
	return l.gate
}

func (l *Lifecycle) Lock() { l.semaphore() <- struct{}{} }

func (l *Lifecycle) TryLock() bool {
	select {
	case l.semaphore() <- struct{}{}:
		return true
	default:
		return false
	}
}

func (l *Lifecycle) Unlock() {
	select {
	case <-l.semaphore():
	default:
		panic("unlock of unlocked lifecycle gate")
	}
}

func (l *Lifecycle) lock(ctx context.Context) error {
	select {
	case l.semaphore() <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Maintain fences established access under the admission gate before any
// external media work. Heartbeats use neither this gate nor database validation.
func (l *Lifecycle) Maintain(ctx context.Context, hub *realtime.Hub, voices *voice.Service) error {
	err := func() error {
		// Shutdown joins maintenance before canceling active HTTP requests.
		// Waiting for an admission that holds the gate must remain cancellable.
		if err := l.lock(ctx); err != nil {
			return err
		}
		defer l.Unlock()
		if err := ctx.Err(); err != nil {
			return err
		}
		if hub != nil {
			hub.ValidateSessions(ctx)
		}
		if voices != nil {
			return voices.ValidateGrants(ctx)
		}
		return nil
	}()
	if ctx.Err() != nil {
		return errors.Join(err, ctx.Err())
	}
	if voices != nil {
		err = errors.Join(err, voices.CleanupGrants(ctx))
	}
	return err
}

// Enforcer binds postcommit effects to the same hub and voice service used by
// admission. It returns media removal errors to the caller; enrollment handlers
// preserve committed credentials, while other mutations propagate the errors.
func Enforcer(events Events, voices *voice.Service) func(context.Context, identity.Effects) error {
	return func(ctx context.Context, effects identity.Effects) error {
		// The mutation is committed: a departing caller must not cancel its
		// required disconnects. Retain request values and an independent bound.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		matches := func(session identity.Session) bool {
			if slices.ContainsFunc(effects.RevokedSessions, func(revoked identity.Session) bool { return revoked.ID == session.ID }) {
				return true
			}
			if effects.GuestGeneration != 0 && session.Kind == identity.Guest && session.Generation < effects.GuestGeneration {
				return true
			}
			return effects.RevokedIdentity == session.Visitor.ID && session.Kind == identity.Account && (effects.AccountDisabled || session.Generation < effects.SecurityGeneration)
		}
		var notice []byte
		if effects.GuestGeneration != 0 {
			var err error
			notice, err = encodeEvent(api.EventTypeAccessRevoked, "", func(payload *api.Event_Payload) error {
				return payload.FromAccessRevoked(api.AccessRevoked{Reason: api.AccessRevokedReasonLinkReplaced})
			})
			if err != nil {
				return err
			}
		}
		if events.Hub != nil {
			events.Hub.RevokeSessions(matches, notice)
		}
		for _, displaced := range effects.Displaced {
			if events.Hub != nil {
				events.Hub.RefreshIdentity(displaced.ID)
			}
		}
		if voices != nil {
			if err := voices.FenceSessions(ctx, matches); err != nil {
				return err
			}
			if effects.GuestGeneration != 0 || effects.RevokedIdentity != "" || len(effects.RevokedSessions) != 0 || len(effects.Displaced) != 0 {
				if err := voices.ValidateGrants(ctx); err != nil {
					return err
				}
				return voices.CleanupGrants(ctx)
			}
		}
		return nil
	}
}

func (l *Lifecycle) Apply(ctx context.Context, effects identity.Effects) error {
	if l.Enforce != nil {
		return l.Enforce(ctx, effects)
	}
	return errors.New("lifecycle enforcement unavailable")
}
