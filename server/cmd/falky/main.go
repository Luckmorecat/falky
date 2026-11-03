// Command falky runs the Falky server and its operator commands.
//
// Usage:
//
//	falky serve                     run the server (applies pending migrations first)
//	falky migrate                   apply pending migrations and exit
//	falky room create <name>        create a room in the running server and print its ID
//	falky room rename <id> <name>   rename a room in the running server
//	falky link show                 print the access link of the running server
//
// Configuration comes from FALKY_* environment variables; see
// internal/platform.LoadConfig.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/kisshot/falky/server/internal/admin"
	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/httpapi"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
)

const usage = `usage: falky <command>

commands:
  serve                     run the server (applies pending migrations first)
  migrate                   apply pending migrations and exit
  room create <name>        create a room in the running server and print its ID
  room rename <id> <name>   rename a room in the running server
  link show                 print the access link of the running server

Quote a name that has spaces: falky room create "Living room"
`

// migrationSources lists the embedded migrations of each module that owns
// tables; platform applies them as one sequence ordered by version.
var migrationSources = []fs.FS{identity.Migrations(), rooms.Migrations(), chat.Migrations()}

// shutdownTimeout bounds how long serve waits for in-flight requests.
const shutdownTimeout = 10 * time.Second

// Entering is limited per client IP to a burst of enterBurst attempts, then
// one more each enterInterval.
const (
	enterBurst    = 10
	enterInterval = 6 * time.Second
)

// Posting is limited per visitor to a burst of postBurst messages, then one
// more each postInterval.
const (
	postBurst    = 10
	postInterval = time.Second
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

// run executes the command in args and returns the process exit code.
// Server commands log JSON lines to stdout; operator commands print their
// result to stdout and their error to stderr.
func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprint(stderr, usage)
		return 2
	}
	// command is the command as messages show it, without the arguments of
	// the commands that take some.
	command := strings.Join(args, " ")
	var (
		server   func(context.Context, platform.Config, *slog.Logger) error
		operator func(context.Context, platform.Config, io.Writer) error
	)
	switch {
	case slices.Equal(args, []string{"serve"}):
		server = serve
	case slices.Equal(args, []string{"migrate"}):
		server = migrate
	case len(args) == 3 && slices.Equal(args[:2], []string{"room", "create"}):
		command = "room create"
		operator = func(ctx context.Context, cfg platform.Config, stdout io.Writer) error {
			return roomCreate(ctx, cfg, stdout, args[2])
		}
	case len(args) == 4 && slices.Equal(args[:2], []string{"room", "rename"}):
		command = "room rename"
		operator = func(ctx context.Context, cfg platform.Config, _ io.Writer) error {
			return roomRename(ctx, cfg, args[2], args[3])
		}
	case slices.Equal(args, []string{"link", "show"}):
		operator = linkShow
	case len(args) == 1 && slices.Contains([]string{"help", "-h", "--help"}, args[0]):
		_, _ = fmt.Fprint(stdout, usage)
		return 0
	default:
		_, _ = fmt.Fprintf(stderr, "falky: unknown command %q\n\n%s", command, usage)
		return 2
	}

	cfg, err := platform.LoadConfig(getenv)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "falky: config: %v\n", err)
		return 1
	}
	if operator != nil {
		if err := operator(ctx, cfg, stdout); err != nil {
			_, _ = fmt.Fprintf(stderr, "falky %s: %v\n", command, err)
			return 1
		}
		return 0
	}
	logger := platform.NewLogger(stdout, cfg.LogLevel)
	if err := server(ctx, cfg, logger); err != nil {
		logger.Error("falky "+command+" failed", "error", err)
		return 1
	}
	return 0
}

// roomCreate creates a room named name in the running server and prints its
// ID.
func roomCreate(ctx context.Context, cfg platform.Config, stdout io.Writer, name string) error {
	id, err := admin.NewClient(cfg.AdminSocket).CreateRoom(ctx, name)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, id)
	return err
}

// roomRename renames the room id to name in the running server.
func roomRename(ctx context.Context, cfg platform.Config, id, name string) error {
	return admin.NewClient(cfg.AdminSocket).RenameRoom(ctx, id, name)
}

// linkShow prints the access link the running server answers with.
func linkShow(ctx context.Context, cfg platform.Config, stdout io.Writer) error {
	link, err := admin.NewClient(cfg.AdminSocket).Link(ctx)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, link)
	return err
}

// openMigrated opens the database, applies pending migrations and creates the
// access link if there is none yet.
func openMigrated(ctx context.Context, cfg platform.Config, logger *slog.Logger) (*platform.DB, platform.Migrations, error) {
	ms, err := platform.LoadMigrations(migrationSources...)
	if err != nil {
		return nil, platform.Migrations{}, err
	}
	db, err := platform.OpenDB(ctx, cfg.DBPath)
	if err != nil {
		return nil, platform.Migrations{}, err
	}
	applied, err := db.Migrate(ctx, ms)
	if err != nil {
		return nil, platform.Migrations{}, errors.Join(err, db.Close())
	}
	logger.Info("database migrated", "path", cfg.DBPath, "applied", applied)
	created, err := identity.New(db, cfg.PublicOrigin).EnsureLink(ctx)
	if err != nil {
		return nil, platform.Migrations{}, errors.Join(err, db.Close())
	}
	if created {
		logger.Info("access link created; print it with falky link show")
	}
	return db, ms, nil
}

func migrate(ctx context.Context, cfg platform.Config, logger *slog.Logger) error {
	db, _, err := openMigrated(ctx, cfg, logger)
	if err != nil {
		return err
	}
	return db.Close()
}

func serve(ctx context.Context, cfg platform.Config, logger *slog.Logger) (err error) {
	if cfg.LiveKitAPIKey == "" || cfg.LiveKitAPISecret == "" {
		return errors.New(platform.EnvLiveKitAPIKey + " and " + platform.EnvLiveKitAPISecret + " must be set")
	}
	db, ms, err := openMigrated(ctx, cfg, logger)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, db.Close()) }()

	var lc net.ListenConfig
	publicLn, err := lc.Listen(ctx, "tcp", cfg.PublicAddr)
	if err != nil {
		return fmt.Errorf("public listener: %w", err)
	}
	internalLn, err := lc.Listen(ctx, "tcp", cfg.InternalAddr)
	if err != nil {
		return errors.Join(fmt.Errorf("internal listener: %w", err), publicLn.Close())
	}
	adminLn, err := admin.Listen(ctx, cfg.AdminSocket)
	if err != nil {
		return errors.Join(err, publicLn.Close(), internalLn.Close())
	}
	return serveOn(ctx, logger, cfg, db, ms, listeners{public: publicLn, internal: internalLn, admin: adminLn})
}

// listeners are where serveOn accepts connections.
type listeners struct {
	public, internal net.Listener
	// admin is the Unix socket of the operator commands.
	admin net.Listener
}

// serveOn serves every listener until ctx is done or one of them fails, then
// shuts them all down, letting in-flight requests finish.
func serveOn(ctx context.Context, logger *slog.Logger, cfg platform.Config, db *platform.DB, ms platform.Migrations, ls listeners) error {
	health := platform.NewHealth(logger)
	health.Require("database", func(ctx context.Context) error { return db.CheckMigrated(ctx, ms) })
	vs := voice.New(voice.NewClient(cfg.LiveKitAPIURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret), voice.Config{
		URL: cfg.LiveKitURL, APIKey: cfg.LiveKitAPIKey, APISecret: cfg.LiveKitAPISecret, RoomCap: cfg.VoiceRoomCap,
	})
	health.Optional("livekit", vs.Check)
	ident := identity.New(db, cfg.PublicOrigin)
	hub := realtime.New(realtime.WithLogger(logger))
	events := httpapi.Events{Hub: hub, Logger: logger}
	rs := rooms.New(db, rooms.WithPublisher(events.RoomChanged))
	handlers := httpapi.New(httpapi.Deps{
		Logger:   logger,
		Health:   health,
		Metrics:  platform.NewMetrics().Handler(),
		Identity: ident,
		Rooms:    rs,
		Chat: chat.New(db,
			chat.WithPostLimit(platform.NewLimiter(postBurst, postInterval, time.Now)),
			chat.WithPublisher(events.MessageCreated)),
		Voice:        vs,
		EnterLimit:   platform.NewLimiter(enterBurst, enterInterval, time.Now),
		Live:         hub,
		PublicOrigin: cfg.PublicOrigin,
	})
	adminHandler := admin.Handler(admin.Deps{Logger: logger, Identity: ident, Rooms: rs})

	errorLog := slog.NewLogLogger(logger.Handler(), slog.LevelWarn)
	servers := []struct {
		name string
		ln   net.Listener
		srv  *http.Server
	}{
		{"public", ls.public, &http.Server{Handler: handlers.Public, ReadHeaderTimeout: 10 * time.Second, ErrorLog: errorLog}},
		{"internal", ls.internal, &http.Server{Handler: handlers.Internal, ReadHeaderTimeout: 10 * time.Second, ErrorLog: errorLog}},
		{"admin", ls.admin, &http.Server{Handler: adminHandler, ReadHeaderTimeout: 10 * time.Second, ErrorLog: errorLog}},
	}
	errc := make(chan error, len(servers))
	for _, s := range servers {
		logger.Info("listening", "listener", s.name, "addr", s.ln.Addr().String())
		go func() { errc <- fmt.Errorf("%s listener: %w", s.name, s.srv.Serve(s.ln)) }()
	}

	var err error
	select {
	case <-ctx.Done():
		logger.Info("shutting down")
	case err = <-errc:
	}
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	for _, s := range servers {
		if e := s.srv.Shutdown(shutdownCtx); e != nil {
			err = errors.Join(err, fmt.Errorf("shut down %s listener: %w", s.name, e))
		}
	}
	// The servers do not track the WebSocket connections they handed over.
	if e := hub.Shutdown(shutdownCtx); e != nil {
		err = errors.Join(err, fmt.Errorf("shut down live updates: %w", e))
	}
	if err == nil {
		logger.Info("stopped")
	}
	return err
}
