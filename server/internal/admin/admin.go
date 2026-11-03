// Package admin is how the operator commands reach the running server: HTTP
// over a Unix socket that only its owner can open, so their effects are
// immediate. It is not part of the public contract.
package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"syscall"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
)

// Listen listens on the Unix socket at path, readable and writable by the
// owner only. A stale socket left by a server that did not shut down cleanly
// is replaced; a socket another server listens on, or any other file, is not.
// Closing the listener removes the socket.
//
// Listen changes the process umask while it creates the socket, so call it
// while no other goroutine creates files.
func Listen(ctx context.Context, path string) (net.Listener, error) {
	if err := removeStale(ctx, path); err != nil {
		return nil, err
	}
	var lc net.ListenConfig
	old := syscall.Umask(0o177)
	ln, err := lc.Listen(ctx, "unix", path)
	syscall.Umask(old)
	if err != nil {
		return nil, fmt.Errorf("admin socket: %w", err)
	}
	return ln, nil
}

func removeStale(ctx context.Context, path string) error {
	fi, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("admin socket: %w", err)
	}
	if fi.Mode().Type() != fs.ModeSocket {
		return fmt.Errorf("admin socket %s: exists and is not a socket", path)
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", path)
	if err == nil {
		return errors.Join(fmt.Errorf("admin socket %s: another server is listening on it", path), conn.Close())
	}
	if !errors.Is(err, syscall.ECONNREFUSED) {
		return fmt.Errorf("admin socket %s: %w", path, err)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("admin socket: remove stale socket: %w", err)
	}
	return nil
}

// Deps are what the admin handler serves from.
type Deps struct {
	Logger   *slog.Logger
	Identity *identity.Service
}

type linkBody struct {
	Link string `json:"link"`
}

type errorBody struct {
	Error string `json:"error"`
}

// Handler returns the handler to serve on the admin socket.
func Handler(deps Deps) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /link", func(w http.ResponseWriter, r *http.Request) {
		link, err := deps.Identity.Link(r.Context())
		if err != nil {
			deps.Logger.Error("admin: read access link", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody{Error: "cannot read the access link"})
			return
		}
		writeJSON(w, http.StatusOK, linkBody{Link: link})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, errorBody{Error: "unknown admin request " + r.Method + " " + r.URL.Path})
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ErrNotRunning reports that no server listens on the admin socket.
var ErrNotRunning = errors.New("the server is not running")

// Client sends operator commands to the server over its admin socket.
type Client struct {
	socket string
	http   *http.Client
}

// NewClient returns a client for the server listening on the socket at path.
func NewClient(path string) *Client {
	return &Client{
		socket: path,
		http: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					var d net.Dialer
					return d.DialContext(ctx, "unix", path)
				},
				DisableKeepAlives: true,
			},
		},
	}
}

// Link returns the current access link.
func (c *Client) Link(ctx context.Context) (string, error) {
	var body linkBody
	if err := c.do(ctx, http.MethodGet, "/link", &body); err != nil {
		return "", err
	}
	return body.Link, nil
}

func (c *Client) do(ctx context.Context, method, path string, out any) (err error) {
	// The host is ignored: the transport always dials the socket.
	req, err := http.NewRequestWithContext(ctx, method, "http://falky"+path, nil)
	if err != nil {
		return fmt.Errorf("admin request: %w", err)
	}
	res, err := c.http.Do(req)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ECONNREFUSED) {
		return fmt.Errorf("%w: nothing listens on %s", ErrNotRunning, c.socket)
	}
	if err != nil {
		return fmt.Errorf("admin request: %w", err)
	}
	defer func() { err = errors.Join(err, res.Body.Close()) }()
	if res.StatusCode != http.StatusOK {
		var e errorBody
		if json.NewDecoder(res.Body).Decode(&e) != nil || e.Error == "" {
			return fmt.Errorf("admin request: %s", res.Status)
		}
		return errors.New(e.Error)
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("admin response: %w", err)
	}
	return nil
}
