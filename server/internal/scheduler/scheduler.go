// Package scheduler owns recurring backend jobs and joins them on shutdown.
package scheduler

import (
	"context"
	"sync"
	"time"
)

// Job runs at Interval, optionally once at startup. Triggers during a run are
// skipped; separate jobs never wait for one another.
type Job struct {
	Interval time.Duration
	Startup  bool
	Run      func(context.Context)
}

// Run starts the jobs, cancels them with ctx and waits for every run to finish.
func Run(ctx context.Context, jobs ...Job) {
	var workers sync.WaitGroup
	for _, job := range jobs {
		workers.Go(func() { run(ctx, job) })
	}
	workers.Wait()
}

func run(ctx context.Context, job Job) {
	ticker := time.NewTicker(job.Interval)
	defer ticker.Stop()
	var completed <-chan struct{}
	start := func() {
		if completed != nil || ctx.Err() != nil {
			return
		}
		done := make(chan struct{})
		completed = done
		go func() { defer close(done); job.Run(ctx) }()
	}
	if job.Startup {
		start()
	}
	for {
		select {
		case <-ctx.Done():
			if completed != nil {
				<-completed
			}
			return
		case <-completed:
			completed = nil
		case <-ticker.C:
			start()
		}
	}
}
