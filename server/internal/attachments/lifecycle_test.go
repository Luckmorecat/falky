package attachments_test

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/attachments"
	attachmentimage "github.com/kisshot/falky/server/internal/attachments/image"
	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
)

func TestConcurrentIncomingAdmissionIsBoundedBeforeReading(t *testing.T) {
	for _, tc := range []struct {
		name     string
		stage    int64
		admitted int
		owner    string
		want     error
	}{
		{"four global streams", attachments.DefaultStagingBytes, 4, "different", attachments.ErrBusy},
		{"staging reservations", 2 * attachmentimage.MaxInputBytes, 2, "different", attachments.ErrStagingFull},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t, attachments.WithStagingQuota(tc.stage))
			started := make(chan struct{}, 4)
			release := make(chan struct{})
			var wg sync.WaitGroup
			errs := make(chan error, 4)
			for i := 0; i < tc.admitted; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					owner := tc.owner + string(rune('a'+i))
					r := readerFunc(func([]byte) (int, error) { started <- struct{}{}; <-release; return 0, io.EOF })
					_, err := f.store.Upload(t.Context(), owner, f.room.ID, "x", r)
					errs <- err
				}(i)
			}
			for i := 0; i < tc.admitted; i++ {
				<-started
			}
			r := &readSentinel{}
			_, err := f.store.Upload(t.Context(), "other", f.room.ID, "x", r)
			if !errors.Is(err, tc.want) || r.read {
				t.Errorf("admission: %v read=%v", err, r.read)
			}
			if tc.admitted == 4 {
				another, createErr := attachments.New(f.db, filepath.Join(f.root, "attachments"), attachments.WithProcessor(preservingProcessor{}))
				if createErr != nil {
					t.Fatal(createErr)
				}
				secondReader := &readSentinel{}
				if _, err = another.Upload(t.Context(), "another-owner", f.room.ID, "x", secondReader); !errors.Is(err, attachments.ErrBusy) || secondReader.read {
					t.Errorf("stream admission must be global: %v read=%v", err, secondReader.read)
				}
			}
			if err = f.store.Recover(t.Context()); err != nil {
				t.Error(err)
			} // Must not reclaim active incoming reservations.
			close(release)
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Error(err)
				}
			}
		})
	}
}

func TestFourReadyDraftsStillOccupyVisitorSlotsAfterRateRefill(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f := setup(t, attachments.WithClock(func() time.Time { return now }))
	for i := 0; i < 4; i++ {
		f.upload(t, "alice", "x")
	}
	now = now.Add(time.Minute)
	r := &readSentinel{}
	if _, err := f.store.Upload(t.Context(), "alice", f.room.ID, "x", r); !errors.Is(err, attachments.ErrBusy) || r.read {
		t.Fatalf("ready admission %v read=%v", err, r.read)
	}
	now = now.Add(time.Hour)
	if err := f.store.Recover(t.Context()); err != nil {
		t.Fatal(err)
	}
	if physicalBytes(t, f.root) != 0 {
		t.Fatal("expired drafts retained content")
	}
	f.upload(t, "alice", "new")
}

func TestTTLStartsAtSuccessfulUploadAndFailedUploadsFreeReservations(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	processor := processorFunc(func(ctx context.Context, source, out string) (attachmentimage.Result, error) {
		now = now.Add(20 * time.Minute)
		return preservingProcessor{}.Process(ctx, source, out)
	})
	f := setup(t, attachments.WithClock(func() time.Time { return now }), attachments.WithProcessor(processor))
	a := f.upload(t, "alice", "content")
	if !a.ExpiresAt.Equal(time.Date(2026, 1, 1, 1, 20, 0, 0, time.UTC)) {
		t.Fatalf("TTL: %v", a.ExpiresAt)
	}
	now = now.Add(time.Hour - time.Millisecond)
	if _, err := f.store.Open(t.Context(), "bob", a.ID); !errors.Is(err, attachments.ErrNotFound) {
		t.Fatal(err)
	}
	c, err := f.store.Open(t.Context(), "alice", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.File.Close()
	now = now.Add(time.Millisecond)
	if _, err = f.store.Open(t.Context(), "alice", a.ID); !errors.Is(err, attachments.ErrExpired) {
		t.Fatalf("TTL boundary: %v", err)
	}
	if physicalBytes(t, f.root) != 0 {
		t.Fatal("TTL bytes not reclaimed")
	}
}

func TestOptimizedOutputUsesActualStagingBytesAndWebPFilename(t *testing.T) {
	processor := processorFunc(func(_ context.Context, _, out string) (attachmentimage.Result, error) {
		err := os.WriteFile(out, []byte("largeroutput"), 0o600)
		return attachmentimage.Result{Optimized: true, Inline: true, ContentType: "image/webp", Size: 12, Width: 2, Height: 3}, err
	})
	f := setup(t, attachments.WithProcessor(processor), attachments.WithStagingQuota(attachmentimage.MaxInputBytes+11))
	a := f.upload(t, "alice", "x")
	if a.Size != 12 || a.Filename != "file.webp" || !a.Inline {
		t.Fatalf("optimized metadata: %+v", a)
	}
	r := &readSentinel{}
	if _, err := f.store.Upload(t.Context(), "bob", f.room.ID, "x", r); !errors.Is(err, attachments.ErrStagingFull) || r.read {
		t.Fatalf("actual output staging: %v read=%v", err, r.read)
	}
	if physicalBytes(t, f.root) != 12 {
		t.Fatal("source not cleaned after optimization")
	}
	if err := f.store.Cancel(t.Context(), "alice", a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Upload(t.Context(), "bob", f.room.ID, "x", strings.NewReader("x")); err != nil {
		t.Fatalf("cancel released reservation: %v", err)
	}
}

func TestExactInputLimitAndOversizeFailureLeaveNoPartialFiles(t *testing.T) {
	f := setup(t, attachments.WithStagingQuota(attachmentimage.MaxInputBytes))
	a, err := f.store.Upload(t.Context(), "alice", f.room.ID, "large", io.LimitReader(zeroReader{}, attachmentimage.MaxInputBytes))
	if err != nil || a.Size != attachmentimage.MaxInputBytes {
		t.Fatalf("exact input: %+v %v", a, err)
	}
	if err = f.store.Cancel(t.Context(), "alice", a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.Upload(t.Context(), "bob", f.room.ID, "large", io.LimitReader(zeroReader{}, attachmentimage.MaxInputBytes+1)); !errors.Is(err, attachments.ErrTooLarge) {
		t.Fatalf("oversize: %v", err)
	}
	if physicalBytes(t, f.root) != 0 {
		t.Fatal("oversize left partial bytes")
	}
	f.upload(t, "carol", "ok")
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestFailedProcessorCleanupDoesNotAccumulateScratch(t *testing.T) {
	var calls atomic.Int32
	var fail atomic.Bool
	p := processorFunc(func(_ context.Context, _, out string) (attachmentimage.Result, error) {
		calls.Add(1)
		err := os.WriteFile(out, []byte("scratch"), 0o600)
		return attachmentimage.Result{}, errors.Join(err, attachmentimage.ErrProcessing)
	})
	f := setup(t, attachments.WithProcessor(p), attachments.WithFileRemover(func(path string) error {
		if fail.Load() {
			return fs.ErrPermission
		}
		return os.Remove(path)
	}))
	fail.Store(true)
	if _, err := f.store.Upload(t.Context(), "alice", f.room.ID, "x", strings.NewReader("source")); !errors.Is(err, attachmentimage.ErrProcessing) {
		t.Fatalf("process failure %v", err)
	}
	if _, err := f.store.Upload(t.Context(), "bob", f.room.ID, "x", strings.NewReader("another")); !errors.Is(err, attachments.ErrCleanupPending) {
		t.Fatalf("cleanup must block scratch: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatal("failed output admitted another converter")
	}
	fail.Store(false)
	if err := f.store.Recover(t.Context()); err != nil {
		t.Fatal(err)
	}
	if physicalBytes(t, f.root) != 0 {
		t.Fatal("failed files survived recovery")
	}
}

func TestRecoveryFromDatabaseOnlySnapshotExpiresMissingContent(t *testing.T) {
	f := setup(t)
	a := f.upload(t, "alice", "posted payload absent from SQLite")
	draft := f.upload(t, "alice", "draft bytes")
	s := chat.New(f.db, chat.WithAttachments(f.store))
	m, _, err := s.Post(t.Context(), identity.Visitor{ID: "alice", Name: "Alice"}, f.room.ID, "key", "text", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := filepath.Join(t.TempDir(), "snapshot.db")
	if err = f.db.Snapshot(t.Context(), snapshot); err != nil {
		t.Fatal(err)
	}
	snapshotBytes, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(snapshotBytes), "posted payload absent from SQLite") {
		t.Fatal("snapshot contains attachment payload")
	}
	ms, err := platform.LoadMigrations(rooms.Migrations(), chat.Migrations(), attachments.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	dbpath := filepath.Join(root, "db")
	r, err := os.Open(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	err = platform.Restore(t.Context(), r, dbpath, ms)
	_ = r.Close()
	if err != nil {
		t.Fatal(err)
	}
	db, err := platform.OpenDB(t.Context(), dbpath, platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var events []attachments.Expiry
	store, err := attachments.New(db, filepath.Join(root, "attachments"), attachments.WithProcessor(preservingProcessor{}), attachments.WithExpiryPublisher(func(err attachments.Expiry) { events = append(events, err) }))
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Recover(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].RoomID != f.room.ID || len(events[0].IDs) != 1 || events[0].IDs[0] != a.ID {
		t.Fatalf("only posted IDs may expire publicly: %+v", events)
	}
	history, err := chat.New(db, chat.WithAttachments(store)).History(t.Context(), f.room.ID, chat.Page{Limit: 10})
	if err != nil || len(history) != 1 || history[0].ID != m.ID || history[0].Body != "text" || history[0].Attachments[0].Availability != "expired" {
		t.Fatalf("restored history %+v: %v", history, err)
	}
	if _, err = store.Open(t.Context(), "new-visitor", a.ID); !errors.Is(err, attachments.ErrExpired) {
		t.Fatalf("missing posted bytes: %v", err)
	}
	if _, _, err = chat.New(db, chat.WithAttachments(store)).Post(t.Context(), identity.Visitor{ID: "alice", Name: "Alice"}, f.room.ID, "draft", "", draft.ID); !errors.Is(err, attachments.ErrInvalidAttachments) {
		t.Fatalf("missing draft posted: %v", err)
	}
	// The original durable tree remains intact for ordinary restarts.
	ordinary, err := attachments.New(f.db, filepath.Join(f.root, "attachments"), attachments.WithProcessor(preservingProcessor{}))
	if err != nil {
		t.Fatal(err)
	}
	if err = ordinary.Recover(t.Context()); err != nil {
		t.Fatal(err)
	}
	content, err := ordinary.Open(t.Context(), "new-visitor", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	_ = content.File.Close()
}

func TestRecoveryRemovesOwnedOrphansAndPreservesUnrelatedFiles(t *testing.T) {
	f := setup(t)
	objects := filepath.Join(f.root, "attachments", "objects")
	unrelated := filepath.Join(objects, "operator-database.db")
	if err := os.WriteFile(unrelated, []byte("unrelated"), 0o600); err != nil {
		t.Fatal(err)
	}
	orphan := filepath.Join(objects, strings.Repeat("a", 32)+".work")
	if err := os.WriteFile(orphan, []byte("partial scratch"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.store.Recover(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(orphan); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("orphan: %v", err)
	}
	b, err := os.ReadFile(unrelated)
	if err != nil || string(b) != "unrelated" {
		t.Fatalf("unrelated file: %q %v", b, err)
	}
}

func TestRecoveryAfterCrashDropsIncomingReservationAndPartialContent(t *testing.T) {
	f := setup(t, attachments.WithStagingQuota(attachmentimage.MaxInputBytes))
	reading := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan error, 1)
	input := readerFunc(func([]byte) (int, error) { close(reading); <-release; return 0, io.EOF })
	go func() { _, err := f.store.Upload(t.Context(), "alice", f.room.ID, "x", input); finished <- err }()
	<-reading
	// A snapshot taken mid-upload models the durable incoming reservation a
	// process crash leaves, without abandoning a goroutine in the test process.
	snapshot := filepath.Join(t.TempDir(), "incoming.db")
	if err := f.db.Snapshot(t.Context(), snapshot); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	db, err := platform.OpenDB(t.Context(), snapshot, platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	root := t.TempDir()
	s, err := attachments.New(db, root, attachments.WithProcessor(preservingProcessor{}), attachments.WithStagingQuota(attachmentimage.MaxInputBytes))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Recover(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Upload(t.Context(), "alice", f.room.ID, "new", strings.NewReader("success")); err != nil {
		t.Fatalf("recovered incoming slot/reservation: %v", err)
	}
}

func TestFilesAndDirectoriesAreOwnerOnly(t *testing.T) {
	f := setup(t)
	a := f.upload(t, "alice", "private")
	c, err := f.store.Open(t.Context(), "alice", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	info, err := c.File.Stat()
	_ = c.File.Close()
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode: %v %v", info, err)
	}
	info, err = os.Stat(filepath.Join(f.root, "attachments", "objects"))
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("directory mode: %v %v", info, err)
	}
}

func TestCloseCancelsProcessingAndStopsAdmission(t *testing.T) {
	started := make(chan struct{})
	processor := processorFunc(func(ctx context.Context, _, _ string) (attachmentimage.Result, error) {
		close(started)
		<-ctx.Done()
		return attachmentimage.Result{}, ctx.Err()
	})
	f := setup(t, attachments.WithProcessor(processor))
	finished := make(chan error, 1)
	go func() {
		_, err := f.store.Upload(t.Context(), "alice", f.room.ID, "x", strings.NewReader("source"))
		finished <- err
	}()
	<-started
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := f.store.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatalf("processing cancellation: %v", err)
	}
	reader := &readSentinel{}
	if _, err := f.store.Upload(t.Context(), "bob", f.room.ID, "x", reader); !errors.Is(err, attachments.ErrClosed) || reader.read {
		t.Fatalf("closed admission: %v read=%v", err, reader.read)
	}
	if physicalBytes(t, f.root) != 0 {
		t.Fatal("shutdown left source bytes")
	}
}
