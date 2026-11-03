package platform_test

import (
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
