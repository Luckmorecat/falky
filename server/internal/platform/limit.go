package platform

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

var nextLimiterID atomic.Uint64

// Limiter limits events per key: a burst of events at once, then one more
// each interval. It forgets keys that are back to a full burst.
type Limiter struct {
	id       uint64
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
	return &Limiter{id: nextLimiterID.Add(1), burst: burst, interval: interval, now: now, next: map[string]time.Time{}}
}

// Allow reports whether one more event for key is within the limit, and
// counts it if so.
func (l *Limiter) Allow(key string) bool { return l.Take(key) == 0 }

// Take counts an allowed event or returns the time until one can be admitted.
func (l *Limiter) Take(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweep(now)
	next, wait := l.nextEvent(now, l.next[key])
	if wait == 0 {
		l.next[key] = next
	}
	return wait
}

func (l *Limiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) >= time.Duration(l.burst)*l.interval {
		for key, full := range l.next {
			if !full.After(now) {
				delete(l.next, key)
			}
		}
		l.lastSweep = now
	}
}

func (l *Limiter) nextEvent(now, full time.Time) (time.Time, time.Duration) {
	if full.Before(now) {
		full = now
	}
	next := full.Add(l.interval)
	return next, max(time.Duration(0), next.Sub(now)-time.Duration(l.burst)*l.interval)
}

// LimitRequest selects a quota and the key charged by one event.
type LimitRequest struct {
	Limiter *Limiter
	Key     string
}

// TakeAll charges every quota atomically, or none when any quota is exhausted.
// The returned delay accounts for all requested quotas and their refill settings.
func TakeAll(requests ...LimitRequest) time.Duration {
	unique := make(map[*Limiter]bool, len(requests))
	var limiters []*Limiter
	for _, request := range requests {
		if !unique[request.Limiter] {
			unique[request.Limiter] = true
			limiters = append(limiters, request.Limiter)
		}
	}
	// Opposite-order requests must acquire shared quotas in the same order.
	sort.Slice(limiters, func(i, j int) bool { return limiters[i].id < limiters[j].id })
	for _, limiter := range limiters {
		limiter.mu.Lock()
		limiter.sweep(limiter.now())
	}
	defer func() {
		for i := len(limiters) - 1; i >= 0; i-- {
			limiters[i].mu.Unlock()
		}
	}()
	projected := make(map[LimitRequest]time.Time, len(requests))
	var retry time.Duration
	for _, request := range requests {
		full, ok := projected[request]
		if !ok {
			full = request.Limiter.next[request.Key]
		}
		next, wait := request.Limiter.nextEvent(request.Limiter.now(), full)
		projected[request] = next
		retry = max(retry, wait)
	}
	if retry == 0 {
		for request, full := range projected {
			request.Limiter.next[request.Key] = full
		}
	}
	return retry
}
