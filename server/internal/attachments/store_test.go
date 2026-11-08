package attachments_test

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
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

type preservingProcessor struct{}

func (preservingProcessor) Process(_ context.Context, source, _ string) (attachmentimage.Result, error) {
	f, err := os.Stat(source)
	if err != nil {
		return attachmentimage.Result{}, err
	}
	return attachmentimage.Result{Size: f.Size(), ContentType: "application/octet-stream"}, nil
}

type fixture struct {
	db    *platform.DB
	store *attachments.Store
	room  rooms.Room
	root  string
}

func setup(t *testing.T, opts ...attachments.Option) fixture {
	t.Helper()
	root := t.TempDir()
	db, err := platform.OpenDB(t.Context(), filepath.Join(root, "db"), platform.NewLogger(io.Discard, 0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ms, err := platform.LoadMigrations(rooms.Migrations(), chat.Migrations(), attachments.Migrations())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Migrate(t.Context(), ms); err != nil {
		t.Fatal(err)
	}
	room, err := rooms.New(db).Create(t.Context(), "Lounge")
	if err != nil {
		t.Fatal(err)
	}
	opts = append([]attachments.Option{attachments.WithProcessor(preservingProcessor{})}, opts...)
	s, err := attachments.New(db, filepath.Join(root, "attachments"), opts...)
	if err != nil {
		t.Fatal(err)
	}
	return fixture{db: db, store: s, room: room, root: root}
}

func TestDraftIsPrivateAndCancellationRemovesContent(t *testing.T) {
	f := setup(t)
	a, err := f.store.Upload(t.Context(), "alice", f.room.ID, "../unsafe\r\nname.txt", strings.NewReader("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if a.Filename != "unsafename.txt" || a.Size != 6 || a.Availability != "ready" {
		t.Fatalf("metadata: %+v", a)
	}
	if _, err = f.store.Visible(t.Context(), "bob", a.ID); !errors.Is(err, attachments.ErrNotFound) {
		t.Fatalf("foreign draft: %v", err)
	}
	c, err := f.store.Open(t.Context(), "alice", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(c.File)
	_ = c.File.Close()
	if err != nil || string(b) != "secret" {
		t.Fatalf("content %q: %v", b, err)
	}
	if err = f.store.Cancel(t.Context(), "alice", a.ID); err != nil {
		t.Fatal(err)
	}
	if err = f.store.Cancel(t.Context(), "alice", a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.Open(t.Context(), "alice", a.ID); !errors.Is(err, attachments.ErrExpired) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestAttachmentOnlyPostingEvictsFIFOAndRetrySurvivesExpiry(t *testing.T) {
	f := setup(t, attachments.WithPostedQuota(8))
	s := chat.New(f.db, chat.WithAttachments(f.store))
	alice := identity.Visitor{ID: "alice", Name: "Alice"}
	upload := func(body string) attachments.Metadata {
		t.Helper()
		a, err := f.store.Upload(t.Context(), alice.ID, f.room.ID, "file.bin", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	a := upload("first")
	first, created, err := s.Post(t.Context(), alice, f.room.ID, "first", "  ", a.ID)
	if err != nil || !created || first.Body != "  " || len(first.Attachments) != 1 {
		t.Fatalf("post: %+v %v %v", first, created, err)
	}
	b := upload("next")
	if c, err := f.store.Open(t.Context(), "reader", a.ID); err != nil {
		t.Fatalf("upload must not evict: %v", err)
	} else {
		_ = c.File.Close()
	}
	second, created, err := s.Post(t.Context(), alice, f.room.ID, "second", "", b.ID)
	if err != nil || !created {
		t.Fatalf("second: %v %v", created, err)
	}
	if _, err = f.store.Open(t.Context(), "reader", a.ID); !errors.Is(err, attachments.ErrExpired) {
		t.Fatalf("victim: %v", err)
	}
	retry, created, err := s.Post(t.Context(), alice, f.room.ID, "first", "  ", a.ID)
	if err != nil || created || retry.ID != first.ID || retry.Attachments[0].Availability != "expired" {
		t.Fatalf("retry: %+v %v %v", retry, created, err)
	}
	if _, _, err = s.Post(t.Context(), alice, f.room.ID, "first", "  ", b.ID); !errors.Is(err, chat.ErrRequestKeyReused) {
		t.Fatalf("identity conflict: %v", err)
	}
	if _, _, err = s.Post(t.Context(), alice, f.room.ID, "third", "", b.ID); !errors.Is(err, attachments.ErrInvalidAttachments) {
		t.Fatalf("consumed: %v", err)
	}
	h, err := s.History(t.Context(), f.room.ID, chat.Page{Limit: 10})
	if err != nil || len(h) != 2 || h[0].ID != second.ID || h[1].Attachments[0].Availability != "expired" {
		t.Fatalf("history %+v: %v", h, err)
	}
}

func TestUnlinkFailureKeepsCommittedMessageAndBoundedCleanupDebt(t *testing.T) {
	var fail atomic.Bool
	f := setup(t, attachments.WithPostedQuota(5), attachments.WithFileRemover(func(p string) error {
		if fail.Load() && strings.HasSuffix(p, ".data") {
			return fs.ErrPermission
		}
		return os.Remove(p)
	}))
	s := chat.New(f.db, chat.WithAttachments(f.store))
	alice := identity.Visitor{ID: "alice", Name: "Alice"}
	a := f.upload(t, "alice", "first")
	first, _, err := s.Post(t.Context(), alice, f.room.ID, "one", "", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	b := f.upload(t, "alice", "next")
	c := f.upload(t, "alice", "last")
	fail.Store(true)
	second, created, err := s.Post(t.Context(), alice, f.room.ID, "two", "", b.ID)
	if err != nil || !created {
		t.Fatalf("committed post must succeed: %+v %v %v", second, created, err)
	}
	if physicalBytes(t, f.root) != 13 {
		t.Fatalf("failed unlink lost accounting/content: %d", physicalBytes(t, f.root))
	}
	if _, _, err = s.Post(t.Context(), alice, f.room.ID, "three", "", c.ID); !errors.Is(err, attachments.ErrCleanupPending) {
		t.Fatalf("cleanup must bound new debt: %v", err)
	}
	retry, created, err := s.Post(t.Context(), alice, f.room.ID, "one", "", a.ID)
	if err != nil || created || retry.ID != first.ID || retry.Attachments[0].Availability != "expired" {
		t.Fatalf("retry %+v %v %v", retry, created, err)
	}
	// Restart retains pending cleanup and staging allocation of the committed post.
	restarted, err := attachments.New(f.db, filepath.Join(f.root, "attachments"), attachments.WithProcessor(preservingProcessor{}), attachments.WithPostedQuota(5), attachments.WithStagingQuota(attachmentimage.MaxInputBytes+7))
	if err != nil {
		t.Fatal(err)
	}
	r := &readSentinel{}
	if _, err = restarted.Upload(t.Context(), "new-owner", f.room.ID, "x", r); !errors.Is(err, attachments.ErrStagingFull) || r.read {
		t.Fatalf("staging debt released early: %v read=%v", err, r.read)
	}
	fail.Store(false)
	if err = restarted.Recover(t.Context()); err != nil {
		t.Fatal(err)
	}
	if physicalBytes(t, f.root) != 8 {
		t.Fatalf("recover did not unlink victim: %d", physicalBytes(t, f.root))
	}
	s = chat.New(f.db, chat.WithAttachments(restarted))
	if _, created, err = s.Post(t.Context(), alice, f.room.ID, "three", "", c.ID); err != nil || !created {
		t.Fatalf("after recovery %v %v", created, err)
	}
	if physicalBytes(t, f.root) != 4 {
		t.Fatalf("FIFO cleanup after recovery: %d", physicalBytes(t, f.root))
	}
}

func (f fixture) upload(t *testing.T, owner, body string) attachments.Metadata {
	t.Helper()
	a, err := f.store.Upload(t.Context(), owner, f.room.ID, "file.bin", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func physicalBytes(t *testing.T, root string) int64 {
	t.Helper()
	var n int64
	_ = filepath.WalkDir(filepath.Join(root, "attachments", "objects"), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		if !d.IsDir() {
			info, err := d.Info()
			if err != nil {
				t.Fatal(err)
			}
			n += info.Size()
		}
		return nil
	})
	return n
}

type readSentinel struct{ read bool }

func (r *readSentinel) Read([]byte) (int, error) { r.read = true; return 0, io.EOF }

func TestFailedPostRollsBackVictimsWithoutDeletingFilesOrPublishing(t *testing.T) {
	var events []attachments.Expiry
	f := setup(t, attachments.WithPostedQuota(5), attachments.WithExpiryPublisher(func(err attachments.Expiry) { events = append(events, err) }))
	var messages []chat.Message
	s := chat.New(f.db, chat.WithAttachments(f.store), chat.WithPublisher(func(m chat.Message) { messages = append(messages, m) }))
	alice := identity.Visitor{ID: "alice", Name: "Alice"}
	a := f.upload(t, "alice", "first")
	if _, _, err := s.Post(t.Context(), alice, f.room.ID, "one", "", a.ID); err != nil {
		t.Fatal(err)
	}
	b := f.upload(t, "alice", "next")
	err := f.db.Write(t.Context(), func(tx *sql.Tx) error {
		_, err := tx.ExecContext(t.Context(), `CREATE TRIGGER reject_consumption BEFORE UPDATE OF message_id ON attachments BEGIN SELECT RAISE(ABORT,'injected failure after victim update'); END`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, created, err := s.Post(t.Context(), alice, f.room.ID, "two", "", b.ID); err == nil || created {
		t.Fatalf("injected rollback: %v %v", created, err)
	}
	if len(events) != 0 || len(messages) != 1 {
		t.Fatalf("rolled back publication: %v %v", events, messages)
	}
	for _, id := range []string{a.ID, b.ID} {
		c, err := f.store.Open(t.Context(), "alice", id)
		if err != nil {
			t.Fatal(err)
		}
		_ = c.File.Close()
	}
	if physicalBytes(t, f.root) != 9 {
		t.Fatal("rollback deleted bytes")
	}
	h, err := s.History(t.Context(), f.room.ID, chat.Page{Limit: 10})
	if err != nil || len(h) != 1 || h[0].Attachments[0].Availability != "posted" {
		t.Fatalf("rolled back history %+v: %v", h, err)
	}
}

type processorFunc func(context.Context, string, string) (attachmentimage.Result, error)

func (p processorFunc) Process(ctx context.Context, a, b string) (attachmentimage.Result, error) {
	return p(ctx, a, b)
}

func TestQueuedUploadCancellationDoesNotWaitForAnotherConversion(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	processor := processorFunc(func(ctx context.Context, source, _ string) (attachmentimage.Result, error) {
		close(started)
		select {
		case <-ctx.Done():
			return attachmentimage.Result{}, ctx.Err()
		case <-release:
			return preservingProcessor{}.Process(ctx, source, "")
		}
	})
	f := setup(t, attachments.WithProcessor(processor))
	first := make(chan error, 1)
	go func() {
		_, err := f.store.Upload(t.Context(), "alice", f.room.ID, "x", strings.NewReader("first"))
		first <- err
	}()
	<-started
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	copied := make(chan struct{})
	input := strings.NewReader("second")
	reader := readerFunc(func(p []byte) (int, error) {
		n, err := input.Read(p)
		if errors.Is(err, io.EOF) {
			close(copied)
		}
		return n, err
	})
	second := make(chan error, 1)
	go func() { _, err := f.store.Upload(ctx, "bob", f.room.ID, "x", reader); second <- err }()
	<-copied
	cancel()
	select {
	case err := <-second:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("queued cancellation: %v", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Error("cancelled queued upload waited for active converter")
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
}

func TestPostedMetadataDoesNotRetainDraftExpiry(t *testing.T) {
	f := setup(t)
	a := f.upload(t, "alice", "data")
	s := chat.New(f.db, chat.WithAttachments(f.store))
	m, _, err := s.Post(t.Context(), identity.Visitor{ID: "alice", Name: "Alice"}, f.room.ID, "key", "", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !m.Attachments[0].ExpiresAt.IsZero() {
		t.Fatalf("posted attachment has draft TTL: %+v", m.Attachments[0])
	}
	h, err := s.History(t.Context(), f.room.ID, chat.Page{Limit: 10})
	if err != nil || !h[0].Attachments[0].ExpiresAt.IsZero() {
		t.Fatalf("posted history TTL: %+v %v", h, err)
	}
}

type readerFunc func([]byte) (int, error)

func (r readerFunc) Read(p []byte) (int, error) { return r(p) }
