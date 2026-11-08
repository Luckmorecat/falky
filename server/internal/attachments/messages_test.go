package attachments_test

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/attachments"
	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/rooms"
)

func TestInvalidNewMessagesNeverEvictAndOrderedIDsDefineRetryIdentity(t *testing.T) {
	f := setup(t, attachments.WithPostedQuota(8))
	s := chat.New(f.db, chat.WithAttachments(f.store))
	alice := identity.Visitor{ID: "alice", Name: "Alice"}
	a := f.upload(t, "alice", "first")
	if _, _, err := s.Post(t.Context(), alice, f.room.ID, "first", "", a.ID); err != nil {
		t.Fatal(err)
	}
	b := f.upload(t, "alice", "xx")
	c := f.upload(t, "alice", "yy")
	large := f.upload(t, "bob", "too large")
	other, err := rooms.New(f.db).Create(t.Context(), "Other")
	if err != nil {
		t.Fatal(err)
	}
	for name, call := range map[string]func() error{
		"duplicate": func() error {
			_, _, err := s.Post(t.Context(), alice, f.room.ID, "duplicate", "", b.ID, b.ID)
			return err
		},
		"foreign visitor": func() error {
			_, _, err := s.Post(t.Context(), identity.Visitor{ID: "bob", Name: "Bob"}, f.room.ID, "foreign", "", b.ID)
			return err
		},
		"foreign room": func() error { _, _, err := s.Post(t.Context(), alice, other.ID, "room", "", b.ID); return err },
		"overlong body": func() error {
			_, _, err := s.Post(t.Context(), alice, f.room.ID, "long", strings.Repeat("x", 4001), b.ID)
			return err
		},
		"impossible quota": func() error {
			_, _, err := s.Post(t.Context(), identity.Visitor{ID: "bob", Name: "Bob"}, f.room.ID, "big", "", large.ID)
			return err
		},
	} {
		if err := call(); err == nil {
			t.Fatalf("%s accepted", name)
		}
		content, err := f.store.Open(t.Context(), "any-reader", a.ID)
		if err != nil {
			t.Fatalf("%s evicted old post: %v", name, err)
		}
		_ = content.File.Close()
	}
	original, _, err := s.Post(t.Context(), alice, f.room.ID, "ordered", "  body  ", c.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if original.Attachments[0].ID != c.ID || original.Attachments[1].ID != b.ID {
		t.Fatalf("attachment order: %+v", original.Attachments)
	}
	if _, _, err = s.Post(t.Context(), alice, f.room.ID, "ordered", "  body  ", b.ID, c.ID); !errors.Is(err, chat.ErrRequestKeyReused) {
		t.Fatalf("order changed identity: %v", err)
	}
	retry, created, err := s.Post(t.Context(), alice, f.room.ID, "ordered", "  body  ", c.ID, b.ID)
	if err != nil || created || !reflect.DeepEqual(retry, original) {
		t.Fatalf("ordered retry %+v %v %v", retry, created, err)
	}
}

func TestFIFOUsesPublicationAcrossRoomsAndClockRollback(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	f := setup(t, attachments.WithPostedQuota(6), attachments.WithClock(func() time.Time { return now }))
	s := chat.New(f.db, chat.WithAttachments(f.store), chat.WithClock(func() time.Time { return now }))
	alice := identity.Visitor{ID: "alice", Name: "Alice"}
	other, err := rooms.New(f.db).Create(t.Context(), "Other")
	if err != nil {
		t.Fatal(err)
	}
	// Upload order deliberately opposes publication order.
	a := f.upload(t, "alice", "aaa")
	b := f.upload(t, "alice", "bbb")
	c, err := f.store.Upload(t.Context(), "alice", other.ID, "c", strings.NewReader("ccc"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.Post(t.Context(), alice, f.room.ID, "b", "", b.ID); err != nil {
		t.Fatal(err)
	}
	now = now.Add(-time.Hour)
	if _, _, err = s.Post(t.Context(), alice, f.room.ID, "a", "", a.ID); err != nil {
		t.Fatal(err)
	}
	// Reading the oldest message cannot change its FIFO position.
	content, err := f.store.Open(t.Context(), "reader", b.ID)
	if err != nil {
		t.Fatal(err)
	}
	_ = content.File.Close()
	if _, _, err = s.Post(t.Context(), alice, other.ID, "c", "", c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.Open(t.Context(), "reader", b.ID); !errors.Is(err, attachments.ErrExpired) {
		t.Fatalf("oldest publication retained: %v", err)
	}
	for _, id := range []string{a.ID, c.ID} {
		content, err := f.store.Open(t.Context(), "reader", id)
		if err != nil {
			t.Fatal(err)
		}
		_ = content.File.Close()
	}
}

func TestConcurrentConsumptionAndCancelChooseExactlyOneOutcome(t *testing.T) {
	f := setup(t)
	s := chat.New(f.db, chat.WithAttachments(f.store))
	alice := identity.Visitor{ID: "alice", Name: "Alice"}
	a := f.upload(t, "alice", "data")
	var wg sync.WaitGroup
	start := make(chan struct{})
	created := make(chan bool, 3)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, made, err := s.Post(t.Context(), alice, f.room.ID, fmt.Sprintf("k%d", i), "", a.ID)
			if err != nil && !errors.Is(err, attachments.ErrInvalidAttachments) {
				t.Errorf("post: %v", err)
			}
			created <- made
		}(i)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		err := f.store.Cancel(t.Context(), "alice", a.ID)
		if err != nil && !errors.Is(err, attachments.ErrNotFound) {
			t.Errorf("cancel: %v", err)
		}
	}()
	close(start)
	wg.Wait()
	close(created)
	count := 0
	for c := range created {
		if c {
			count++
		}
	}
	if count > 1 {
		t.Fatal("draft consumed twice")
	}
	h, err := s.History(t.Context(), f.room.ID, chat.Page{Limit: 10})
	if err != nil || len(h) != count {
		t.Fatalf("history=%v count=%d: %v", h, count, err)
	}
	if count == 1 {
		content, err := f.store.Open(t.Context(), "reader", a.ID)
		if err != nil {
			t.Fatalf("cancel deleted posted content: %v", err)
		}
		_ = content.File.Close()
	} else if _, err = f.store.Open(t.Context(), "alice", a.ID); !errors.Is(err, attachments.ErrExpired) {
		t.Fatalf("cancelled content: %v", err)
	}
}
