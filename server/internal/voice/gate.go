package voice

import (
	"context"
	"sync"
)

// operationGate keeps a job's cancellation independent of an HTTP holder:
// shutdown joins jobs before closing the requests that may hold these gates.
// Cancellation leaves no acquired token or detached waiter.
type operationGate struct {
	once sync.Once
	held chan struct{}
}

func (g *operationGate) lock(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	g.once.Do(func() { g.held = make(chan struct{}, 1) })
	select {
	case g.held <- struct{}{}:
		if err := ctx.Err(); err != nil {
			g.unlock()
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (g *operationGate) unlock() {
	select {
	case <-g.held:
	default:
		panic("unlock of unlocked voice gate")
	}
}
