package httpapi

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/voice"

	"github.com/kisshot/falky/server/internal/identity"
)

// Lifecycle serializes access mutations with final live and voice admission.
// Enforce runs after commit while the gate is held; it must finish all required
// disconnects before returning. Configure it before serving either listener.
type Lifecycle struct {
	sync.Mutex
	Enforce func(context.Context, identity.Effects) error
}

// Enforcer binds postcommit effects to the same hub and voice service used by
// admission. Required media removal errors propagate to the mutation caller.
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
			if err := voices.Revoke(ctx, matches); err != nil {
				return err
			}
			if effects.GuestGeneration != 0 || effects.RevokedIdentity != "" || len(effects.RevokedSessions) != 0 || len(effects.Displaced) != 0 {
				return voices.Refresh(ctx)
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
