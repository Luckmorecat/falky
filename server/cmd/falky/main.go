// Command falky runs the Falky server and its operator commands.
//
// Usage:
//
//	falky serve       run the server (applies pending migrations first)
//	falky migrate     apply pending migrations and exit
//	falky link show   print the access link of the running server
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
	"github.com/kisshot/falky/server/internal/httpapi"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
)

const usage = `usage: falky <command>

commands:
  serve       run the server (applies pending migrations first)
  migrate     apply pending migrations and exit
  link show   print the access link of the running server
`

// migrationSources lists the embedded migrations of each module that owns
// tables; platform applies them as one sequence ordered by version.
var migrationSources = []fs.FS{identity.Migrations()}

// shutdownTimeout bounds how long serve waits for in-flight requests.
const shutdownTimeout = 10 * time.Second

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
	name := strings.Join(args, " ")
	var (
		server   func(context.Context, platform.Config, *slog.Logger) error
		operator func(context.Context, platform.Config, io.Writer) error
	)
	switch {
	case slices.Equal(args, []string{"serve"}):
		server = serve
	case slices.Equal(args, []string{"migrate"}):
		server = migrate
	case slices.Equal(args, []string{"link", "show"}):
		operator = linkShow
	case len(args) == 1 && slices.Contains([]string{"help", "-h", "--help"}, args[0]):
		_, _ = fmt.Fprint(stdout, usage)
		return 0
	default:
		_, _ = fmt.Fprintf(stderr, "falky: unknown command %q\n\n%s", name, usage)
		return 2
	}

	cfg, err := platform.LoadConfig(getenv)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "falky: config: %v\n", err)
		return 1
	}
	if operator != nil {
		if err := operator(ctx, cfg, stdout); err != nil {
			_, _ = fmt.Fprintf(stderr, "falky %s: %v\n", name, err)
			return 1
		}
		return 0
	}
	logger := platform.NewLogger(stdout, cfg.LogLevel)
	if err := server(ctx, cfg, logger); err != nil {
		logger.Error("falky "+name+" failed", "error", err)
		return 1
	}
	return 0
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
	handlers := httpapi.New(httpapi.Deps{
		Logger:  logger,
		Health:  health,
		Metrics: platform.NewMetrics().Handler(),
	})
	adminHandler := admin.Handler(admin.Deps{Logger: logger, Identity: identity.New(db, cfg.PublicOrigin)})

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
	if err == nil {
		logger.Info("stopped")
	}
	return err
}
