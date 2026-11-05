package voice_test

import (
	"bytes"
	"errors"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/voice"
)

func TestBackgroundRefreshReportsOutageRemindersAndRecoveryPrivately(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFixture()
		var logs logBuffer
		f.s = voice.New(f.livekit, f.access, f.access, voice.Config{}, voice.WithLogger(platform.NewLogger(&logs, 0)))
		f.livekit.Fail(errors.New("private-token private-name"))
		startRun(t, f.s)
		synctest.Wait()
		if strings.Count(logs.String(), `"msg":"voice occupancy refresh failed"`) != 1 {
			t.Fatalf("missing first failure: %s", logs.String())
		}
		time.Sleep(voice.RefreshInterval)
		synctest.Wait()
		if strings.Count(logs.String(), `"msg":"voice occupancy refresh failed"`) != 1 {
			t.Fatalf("refresh flooding: %s", logs.String())
		}
		time.Sleep(voice.RefreshInterval)
		synctest.Wait()
		if strings.Count(logs.String(), `"msg":"voice occupancy refresh failed"`) != 2 {
			t.Fatalf("missing bounded reminder: %s", logs.String())
		}
		f.livekit.Fail(nil)
		time.Sleep(voice.RefreshInterval)
		synctest.Wait()
		if strings.Count(logs.String(), `"msg":"voice occupancy refresh recovered"`) != 1 {
			t.Fatalf("missing recovery: %s", logs.String())
		}
		time.Sleep(voice.RefreshInterval)
		synctest.Wait()
		if strings.Count(logs.String(), `"msg":"voice occupancy refresh recovered"`) != 1 {
			t.Fatal("healthy refresh flooding")
		}
		if strings.Contains(logs.String(), "private-") {
			t.Fatalf("private error leaked: %s", logs.String())
		}
	})
}

// logBuffer permits observing background log writes under the race detector.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
