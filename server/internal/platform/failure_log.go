package platform

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// FailureLog logs the first failure, changes of safe failure category, and a
// reminder at most once a minute, followed by one recovery. Its zero value is
// ready for one fixed operation/component. It retains no error text.
type FailureLog struct {
	mu         sync.Mutex
	kind       string
	last       time.Time
	suppressed int
}

// Report records the result of a check. event and attrs must be safe, static
// operation metadata; callers must not pass arbitrary errors or payloads.
func (f *FailureLog) Report(ctx context.Context, logger *slog.Logger, event string, err error, attrs ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err == nil {
		if f.kind != "" {
			logger.InfoContext(ctx, event+" recovered", append(attrs, "suppressed", f.suppressed)...)
			f.kind = ""
			f.suppressed = 0
		}
		return
	}
	kind := ErrorKind(err)
	if kind == f.kind && time.Since(f.last) < time.Minute {
		f.suppressed++
		return
	}
	logger.WarnContext(ctx, event+" failed", append(attrs, "error_kind", kind, "suppressed", f.suppressed)...)
	f.kind, f.last, f.suppressed = kind, time.Now(), 0
}
