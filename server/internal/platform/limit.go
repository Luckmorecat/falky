package platform

import (
	"sync"
	"time"
)

// Limiter limits events per key: a burst of events at once, then one more
// each interval. It forgets keys that are back to a full burst.
type Limiter struct {
	burst    int
	interval time.Duration
	now      func() time.Time

	mu sync.Mutex
	// next maps a key to when its burst is full again, or a past time.
	next      map[string]time.Time
	lastSweep time.Time
}

// NewLimiter returns a limiter allowing burst events per key at once and one
// more each interval, reading the time from now.
func NewLimiter(burst int, interval time.Duration, now func() time.Time) *Limiter {
	return &Limiter{burst: burst, interval: interval, now: now, next: map[string]time.Time{}}
}

// Allow reports whether one more event for key is within the limit, and
// counts it if so.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	window := time.Duration(l.burst) * l.interval
	if now.Sub(l.lastSweep) >= window {
		for k, t := range l.next {
			if !t.After(now) {
				delete(l.next, k)
			}
		}
		l.lastSweep = now
	}
	full := l.next[key]
	if full.Before(now) {
		full = now
	}
	// Each event pushes the full-again time one interval further; an event
	// is allowed while that stays within one burst of now.
	if full.Add(l.interval).Sub(now) > window {
		return false
	}
	l.next[key] = full.Add(l.interval)
	return true
}
