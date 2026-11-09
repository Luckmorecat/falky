package scheduler_test

import (
	"context"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/kisshot/falky/server/internal/scheduler"
)

func TestJobsKeepTheirCadenceWhileBusyJobsSkipTriggers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		var heartbeats, maintenance, attachments atomic.Int32
		release := make(chan struct{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			scheduler.Run(ctx,
				scheduler.Job{Interval: 20 * time.Second, Run: func(context.Context) { heartbeats.Add(1) }},
				scheduler.Job{Interval: 30 * time.Second, Startup: true, Run: func(context.Context) { maintenance.Add(1); <-release }},
				scheduler.Job{Interval: time.Minute, Run: func(context.Context) { attachments.Add(1) }},
			)
		}()
		synctest.Wait()
		if maintenance.Load() != 1 || heartbeats.Load() != 0 || attachments.Load() != 0 {
			t.Fatalf("startup runs = heartbeat %d, maintenance %d, attachments %d", heartbeats.Load(), maintenance.Load(), attachments.Load())
		}
		for range 3 {
			time.Sleep(20 * time.Second)
			synctest.Wait()
		}
		if maintenance.Load() != 1 || heartbeats.Load() != 3 || attachments.Load() != 1 {
			t.Fatalf("runs at 60s = heartbeat %d, maintenance %d, attachments %d", heartbeats.Load(), maintenance.Load(), attachments.Load())
		}
		close(release)
		synctest.Wait()
		if maintenance.Load() != 1 {
			t.Fatal("busy triggers were queued instead of skipped")
		}
		time.Sleep(30 * time.Second)
		synctest.Wait()
		if maintenance.Load() != 2 {
			t.Fatalf("maintenance did not resume at its next trigger: %d", maintenance.Load())
		}
		cancel()
		<-done
	})
}

func TestCancellationStopsNewRunsAndJoinsTheRunningJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		var runs atomic.Int32
		cancelled, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
		go func() {
			defer close(done)
			scheduler.Run(ctx, scheduler.Job{Interval: time.Second, Startup: true, Run: func(ctx context.Context) {
				runs.Add(1)
				<-ctx.Done()
				close(cancelled)
				<-release
			}})
		}()
		synctest.Wait()
		cancel()
		<-cancelled
		time.Sleep(time.Minute)
		synctest.Wait()
		select {
		case <-done:
			t.Fatal("scheduler returned before the running job joined")
		default:
		}
		if runs.Load() != 1 {
			t.Fatalf("new runs after shutdown: %d", runs.Load())
		}
		close(release)
		<-done
	})
}
