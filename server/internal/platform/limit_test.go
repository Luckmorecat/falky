package platform_test

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/platform"
)

func TestLimiterAllowsABurstThenOneEventPerInterval(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	l := platform.NewLimiter(3, 10*time.Second, func() time.Time { return now })

	for i := range 3 {
		if !l.Allow("a") {
			t.Fatalf("event %d of the burst refused", i+1)
		}
	}
	if l.Allow("a") {
		t.Error("event beyond the burst allowed")
	}
	if !l.Allow("b") {
		t.Error("another key's first event refused")
	}

	now = now.Add(9 * time.Second)
	if l.Allow("a") {
		t.Error("event allowed before an interval passed")
	}
	now = now.Add(time.Second)
	if !l.Allow("a") {
		t.Error("event refused after an interval passed")
	}
	if l.Allow("a") {
		t.Error("second event allowed after one interval")
	}

	// After a quiet burst-long window the key has its whole burst again.
	now = now.Add(30 * time.Second)
	for i := range 3 {
		if !l.Allow("a") {
			t.Fatalf("event %d of the refilled burst refused", i+1)
		}
	}
	if l.Allow("a") {
		t.Error("event beyond the refilled burst allowed")
	}
}

func TestLimiterRetryAndAtomicQuotaCharging(t *testing.T) {
	now := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	browser := platform.NewLimiter(1, 7*time.Second, clock)
	ip := platform.NewLimiter(1, 11*time.Second, clock)
	if !ip.Allow("ip") {
		t.Fatal("initial IP token refused")
	}
	now = now.Add(3 * time.Second)
	if wait := platform.TakeAll(platform.LimitRequest{Limiter: browser, Key: "browser"}, platform.LimitRequest{Limiter: ip, Key: "ip"}); wait != 8*time.Second {
		t.Fatalf("quota wait=%s", wait)
	}
	if wait := browser.Take("browser"); wait != 0 {
		t.Fatalf("IP rejection charged browser: %s", wait)
	}
	if wait := browser.Take("browser"); wait != 7*time.Second {
		t.Fatalf("browser wait=%s", wait)
	}
	now = now.Add(2 * time.Second)
	if wait := browser.Take("browser"); wait != 5*time.Second {
		t.Fatalf("remaining retry=%s", wait)
	}
	now = now.Add(6 * time.Second)
	if wait := platform.TakeAll(platform.LimitRequest{Limiter: ip, Key: "ip"}, platform.LimitRequest{Limiter: browser, Key: "browser"}); wait != 0 {
		t.Fatalf("refilled quotas refused: %s", wait)
	}
	if ip.Allow("ip") || browser.Allow("browser") {
		t.Fatal("successful allocation did not charge both quotas")
	}
}

func TestAtomicQuotasHandleConcurrentOppositeOrderAndRepeatedKeys(t *testing.T) {
	now := time.Now()
	clock := func() time.Time { return now }
	first, second := platform.NewLimiter(32, time.Second, clock), platform.NewLimiter(32, time.Second, clock)
	var admitted atomic.Int64
	var workers sync.WaitGroup
	for i := range 64 {
		workers.Go(func() {
			a, b := first, second
			if i%2 == 1 {
				a, b = b, a
			}
			if platform.TakeAll(platform.LimitRequest{Limiter: a, Key: "key"}, platform.LimitRequest{Limiter: b, Key: "key"}) == 0 {
				admitted.Add(1)
			}
		})
	}
	finished := make(chan struct{})
	go func() { workers.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("quota lock order deadlocked")
	}
	if count := admitted.Load(); count != 32 {
		t.Fatalf("atomic admissions=%d", count)
	}
	repeated := platform.NewLimiter(2, time.Second, clock)
	request := platform.LimitRequest{Limiter: repeated, Key: "key"}
	if wait := platform.TakeAll(request, request, request); wait != time.Second {
		t.Fatalf("oversized batch wait=%s", wait)
	}
	if wait := platform.TakeAll(request, request); wait != 0 {
		t.Fatalf("rejected batch consumed quota: %s", wait)
	}
	if repeated.Allow("key") {
		t.Fatal("repeated quota was not charged twice")
	}
}
