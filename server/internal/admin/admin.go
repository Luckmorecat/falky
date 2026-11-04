// Package admin is how the operator commands reach the running server: HTTP
// over a Unix socket that only its owner can open, so their effects are
// immediate. It is not part of the public contract.
package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
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
	Rooms    *rooms.Service
	// Voice is emptied once the access link is replaced.
	Voice *voice.Service
	// AccessRevoked tells every live-update connection that its visitor's
	// access ended, and closes it, once the access link is replaced.
	AccessRevoked func()
	// DB is the database snapshots are taken of, into SnapshotDir.
	DB          *platform.DB
	SnapshotDir string
}

type linkBody struct {
	Link string `json:"link"`
}

// roomNameBody is the body of a request that creates or renames a room.
type roomNameBody struct {
	Name string `json:"name"`
}

// roomBody is a room, as answered to creating or renaming one.
type roomBody struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type snapshotBody struct {
	Path string `json:"path"`
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
	mux.HandleFunc("POST /link/rotate", func(w http.ResponseWriter, r *http.Request) {
		link, err := deps.Identity.Rotate(r.Context())
		if err != nil {
			deps.Logger.Error("admin: rotate access link", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody{Error: "cannot rotate the access link"})
			return
		}
		// The new link is stored, so old cookies are already refused; what
		// the visitors of the old link still have open ends now.
		deps.AccessRevoked()
		if err := deps.Voice.RemoveAll(r.Context()); err != nil {
			deps.Logger.Error("admin: voice not emptied after rotating the access link; "+
				"the next refresh removes its participants", "error", err)
		}
		deps.Logger.Info("access link rotated")
		writeJSON(w, http.StatusOK, linkBody{Link: link})
	})
	mux.HandleFunc("POST /rooms", func(w http.ResponseWriter, r *http.Request) {
		var body roomNameBody
		if !decode(w, r, &body) {
			return
		}
		room, err := deps.Rooms.Create(r.Context(), body.Name)
		writeRoom(w, deps.Logger, "create room", room, err)
	})
	mux.HandleFunc("PATCH /rooms/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body roomNameBody
		if !decode(w, r, &body) {
			return
		}
		id := r.PathValue("id")
		room, err := deps.Rooms.Rename(r.Context(), id, body.Name)
		if errors.Is(err, rooms.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errorBody{Error: fmt.Sprintf("no room has the ID %q", id)})
			return
		}
		writeRoom(w, deps.Logger, "rename room", room, err)
	})
	mux.HandleFunc("POST /snapshots", func(w http.ResponseWriter, r *http.Request) {
		path, err := snapshot(r.Context(), deps)
		switch {
		case errors.Is(err, fs.ErrExist):
			writeJSON(w, http.StatusConflict, errorBody{Error: path + " already exists; try again in a second"})
		case err != nil:
			deps.Logger.Error("admin: snapshot", "error", err)
			writeJSON(w, http.StatusInternalServerError, errorBody{Error: "cannot take a snapshot"})
		default:
			deps.Logger.Info("snapshot taken", "path", path)
			writeJSON(w, http.StatusOK, snapshotBody{Path: path})
		}
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, errorBody{Error: "unknown admin request " + r.Method + " " + r.URL.Path})
	})
	return mux
}

// snapshot takes a snapshot of the database into a new file in the snapshot
// directory, named after the time, and returns the file's absolute path.
func snapshot(ctx context.Context, deps Deps) (string, error) {
	dir, err := filepath.Abs(deps.SnapshotDir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "falky-"+time.Now().UTC().Format("20060102T150405Z")+".db")
	return path, deps.DB.Snapshot(ctx, path)
}

// decode reads the JSON request body into v, or answers 400 and reports false.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid request body: " + err.Error()})
		return false
	}
	return true
}

// writeRoom answers with room, or with what err says went wrong doing what.
func writeRoom(w http.ResponseWriter, logger *slog.Logger, what string, room rooms.Room, err error) {
	switch {
	case errors.Is(err, rooms.ErrInvalidName):
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
	case errors.Is(err, rooms.ErrNameTaken):
		writeJSON(w, http.StatusConflict, errorBody{Error: err.Error()})
	case err != nil:
		logger.Error("admin: "+what, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: "cannot " + what})
	default:
		writeJSON(w, http.StatusOK, roomBody{ID: room.ID, Name: room.Name})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ErrNotRunning reports that no server listens on the admin socket.
var ErrNotRunning = errors.New("the server is not running")

// Requests time out after requestTimeout, except snapshots, which may take
// longer on a large database.
const (
	requestTimeout  = 10 * time.Second
	snapshotTimeout = 10 * time.Minute
)

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
	if err := c.do(ctx, http.MethodGet, "/link", nil, &body); err != nil {
		return "", err
	}
	return body.Link, nil
}

// RotateLink replaces the access link and returns the new one. Visitors
// admitted by the old link lose their access, live-update connections and
// voice.
func (c *Client) RotateLink(ctx context.Context) (string, error) {
	var body linkBody
	if err := c.do(ctx, http.MethodPost, "/link/rotate", nil, &body); err != nil {
		return "", err
	}
	return body.Link, nil
}

// CreateRoom creates a room named name and returns its ID.
func (c *Client) CreateRoom(ctx context.Context, name string) (string, error) {
	var body roomBody
	if err := c.do(ctx, http.MethodPost, "/rooms", roomNameBody{Name: name}, &body); err != nil {
		return "", err
	}
	return body.ID, nil
}

// RenameRoom renames the room id to name.
func (c *Client) RenameRoom(ctx context.Context, id, name string) error {
	var body roomBody
	return c.do(ctx, http.MethodPatch, "/rooms/"+url.PathEscape(id), roomNameBody{Name: name}, &body)
}

// Snapshot has the server take a snapshot of its database and returns where
// the snapshot went, as a path inside the server's file system.
func (c *Client) Snapshot(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, snapshotTimeout)
	defer cancel()
	var body snapshotBody
	if err := c.do(ctx, http.MethodPost, "/snapshots", nil, &body); err != nil {
		return "", err
	}
	return body.Path, nil
}

// do sends a request with in, if not nil, as its JSON body, and decodes the
// answer into out. Unless ctx has a deadline, the request times out after
// requestTimeout.
func (c *Client) do(ctx context.Context, method, path string, in, out any) (err error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, requestTimeout)
		defer cancel()
	}
	var reqBody io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("admin request: %w", err)
		}
		reqBody = bytes.NewReader(b)
	}
	// The host is ignored: the transport always dials the socket.
	req, err := http.NewRequestWithContext(ctx, method, "http://falky"+path, reqBody)
	if err != nil {
		return fmt.Errorf("admin request: %w", err)
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
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
