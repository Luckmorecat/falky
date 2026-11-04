// Package realtime is the live-update hub. It holds every open live-update
// WebSocket, sends each published event to the connections allowed to receive
// it, closes connections that stop answering heartbeats and disconnects
// clients that fall behind. Connections carry events from the server only.
package realtime

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Event is one live update, as published.
type Event struct {
	// RoomID, when set, is the room the event is about: only connections
	// whose subscriber may receive events about that room get it. When
	// empty, every connection gets it.
	RoomID string
	// Data is the encoded event, sent as one text message.
	Data []byte
}

// Subscriber is the visitor a connection serves.
type Subscriber struct {
	VisitorID string
	// MayReceive reports whether events about the room roomID may reach the
	// visitor. It is asked again for each such event; nil allows every room.
	MayReceive func(ctx context.Context, roomID string) bool
}

// StatusBehind is the close code of a connection whose client fell behind:
// its queue of events waiting to be sent filled up.
const StatusBehind websocket.StatusCode = 4000

// Defaults of the options.
const (
	defaultPingInterval = 20 * time.Second
	defaultPongTimeout  = 10 * time.Second
	defaultQueueSize    = 128
	// writeTimeout bounds sending one event, so that a stalled connection
	// cannot hold its sender forever.
	writeTimeout = 10 * time.Second
)

// Hub fans events out to the open connections.
type Hub struct {
	logger       *slog.Logger
	pingInterval time.Duration
	pongTimeout  time.Duration
	queueSize    int
	connected    func(visitorID string, connected bool)

	mu    sync.Mutex
	conns map[*conn]struct{}
	// visitors counts the open connections of each connected visitor.
	visitors map[string]int
	closed   bool
	serving  sync.WaitGroup
}

// Option changes how New sets up the Hub.
type Option func(*Hub)

// WithLogger logs to logger instead of discarding.
func WithLogger(logger *slog.Logger) Option {
	return func(h *Hub) { h.logger = logger }
}

// WithHeartbeat pings each connection every interval and closes one that has
// not answered within timeout.
func WithHeartbeat(interval, timeout time.Duration) Option {
	return func(h *Hub) { h.pingInterval, h.pongTimeout = interval, timeout }
}

// WithQueueSize makes each connection hold at most n events waiting to be
// sent; a connection with n waiting when another is published is closed with
// StatusBehind.
func WithQueueSize(n int) Option {
	return func(h *Hub) { h.queueSize = n }
}

// WithConnectedFunc calls f with connected true when a visitor's first
// connection opens and with connected false when their last one closes. A
// connection opens once its upgrade has succeeded; a failed upgrade opens
// nothing. The calls for one visitor alternate, starting with true. f runs
// while the Hub is locked, so it must be quick and must not call the Hub.
func WithConnectedFunc(f func(visitorID string, connected bool)) Option {
	return func(h *Hub) { h.connected = f }
}

// New returns a Hub with no connections.
func New(opts ...Option) *Hub {
	h := &Hub{
		logger:       slog.New(slog.DiscardHandler),
		pingInterval: defaultPingInterval,
		pongTimeout:  defaultPongTimeout,
		queueSize:    defaultQueueSize,
		connected:    func(string, bool) {},
		conns:        make(map[*conn]struct{}),
		visitors:     make(map[string]int),
	}
	for _, opt := range opts {
		opt(h)
	}
	return h
}

// conn is one open connection.
type conn struct {
	sub   Subscriber
	queue chan Event
	// ended is closed when the hub lets go of the connection; status is then
	// the close code to end it with, if it is still open.
	ended  chan struct{}
	status websocket.StatusCode
	reason string
	// open is set once the upgrade has succeeded and the connection counts
	// as one of its visitor's.
	open bool
}

// Publish queues e on every open connection without waiting for any of them.
// A connection whose queue is full is closed with StatusBehind; its client
// catches up through the HTTP API.
func (h *Hub) Publish(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns {
		select {
		case c.queue <- e:
		default:
			h.logger.Info("live connection fell behind; closing it", "visitor", c.sub.VisitorID)
			h.removeLocked(c, StatusBehind, "fell behind; catch up and reconnect")
		}
	}
}

// Serve upgrades the request to a WebSocket for sub and sends it events until
// the connection ends. The caller has checked the request's Origin and
// resolved its visitor; Serve accepts any origin. The connection receives
// every event published once its upgrade has begun. Serve reports whether the
// connection opened: false when the upgrade failed or the Hub was shut down.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, sub Subscriber) (opened bool) {
	c := &conn{sub: sub, queue: make(chan Event, h.queueSize), ended: make(chan struct{})}
	registered := h.add(c)
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		h.logger.Debug("live connection refused", "error", err) // Accept answered the request
		if registered {
			h.remove(c)
			h.serving.Done()
		}
		return false
	}
	if !registered {
		_ = ws.Close(websocket.StatusGoingAway, "server shutting down")
		return false
	}
	defer h.serving.Done()
	defer h.remove(c)
	opened = h.opened(c)

	ctx, cancel := context.WithCancel(r.Context())
	var wg sync.WaitGroup
	wg.Go(func() { h.send(ctx, c, ws) })
	wg.Go(func() { h.heartbeat(ctx, c, ws) })
	wg.Go(func() {
		select {
		case <-ctx.Done():
		case <-c.ended:
			_ = ws.Close(c.status, c.reason)
		}
	})
	discardIncoming(ctx, ws)
	cancel()
	wg.Wait()
	_ = ws.CloseNow()
	return opened
}

// add registers c to receive events, unless the Hub is shut down. It does not
// count c as open yet: its upgrade may still fail.
func (h *Hub) add(c *conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return false
	}
	h.serving.Add(1)
	h.conns[c] = struct{}{}
	return true
}

// opened counts c, whose upgrade has succeeded, as one of its visitor's open
// connections, unless the Hub has already let go of it. It reports whether it
// did.
func (h *Hub) opened(c *conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.conns[c]; !ok {
		return false
	}
	c.open = true
	h.visitors[c.sub.VisitorID]++
	if h.visitors[c.sub.VisitorID] == 1 {
		h.connected(c.sub.VisitorID, true)
	}
	return true
}

// remove unregisters c, which has ended by itself.
func (h *Hub) remove(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeLocked(c, websocket.StatusNormalClosure, "")
}

// removeLocked unregisters c if it still is registered, and has it closed
// with status and reason if it is still open.
func (h *Hub) removeLocked(c *conn, status websocket.StatusCode, reason string) {
	if _, ok := h.conns[c]; !ok {
		return
	}
	delete(h.conns, c)
	c.status, c.reason = status, reason
	close(c.ended)
	if !c.open {
		return
	}
	id := c.sub.VisitorID
	h.visitors[id]--
	if h.visitors[id] == 0 {
		delete(h.visitors, id)
		h.connected(id, false)
	}
}

// send writes c's queued events to ws until ctx is done or a write fails.
func (h *Hub) send(ctx context.Context, c *conn, ws *websocket.Conn) {
	for {
		var e Event
		select {
		case <-ctx.Done():
			return
		case <-c.ended: // being closed: what is left, the client catches up on
			return
		case e = <-c.queue:
		}
		if e.RoomID != "" && c.sub.MayReceive != nil && !c.sub.MayReceive(ctx, e.RoomID) {
			continue
		}
		wctx, cancel := context.WithTimeout(ctx, writeTimeout)
		err := ws.Write(wctx, websocket.MessageText, e.Data)
		cancel()
		if err != nil {
			h.logger.Debug("live connection write failed", "visitor", c.sub.VisitorID, "error", err)
			_ = ws.CloseNow()
			return
		}
	}
}

// heartbeat pings ws every ping interval and closes it when a pong does not
// come back in time.
func (h *Hub) heartbeat(ctx context.Context, c *conn, ws *websocket.Conn) {
	ticker := time.NewTicker(h.pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		pctx, cancel := context.WithTimeout(ctx, h.pongTimeout)
		err := ws.Ping(pctx)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				h.logger.Debug("live connection missed a heartbeat; closing it", "visitor", c.sub.VisitorID, "error", err)
			}
			_ = ws.CloseNow()
			return
		}
	}
}

// discardIncoming reads ws until it closes, which keeps control frames
// (pongs, the peer's close) flowing, and throws away every data message.
func discardIncoming(ctx context.Context, ws *websocket.Conn) {
	for {
		_, r, err := ws.Reader(ctx)
		if err == nil {
			_, err = io.Copy(io.Discard, r)
		}
		if err != nil {
			return
		}
	}
}

// Shutdown closes every connection with close code 1001 (going away), refuses
// new ones, and waits until each has ended or ctx is done.
func (h *Hub) Shutdown(ctx context.Context) error {
	h.mu.Lock()
	h.closed = true
	for c := range h.conns {
		h.removeLocked(c, websocket.StatusGoingAway, "server shutting down")
	}
	h.mu.Unlock()

	done := make(chan struct{})
	go func() {
		h.serving.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("live connections still open: %w", ctx.Err())
	}
}
