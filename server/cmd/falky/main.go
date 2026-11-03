// Command falky runs the Falky server and its operator commands.
//
// Usage:
//
//	falky serve     run the server (applies pending migrations first)
//	falky migrate   apply pending migrations and exit
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
	"syscall"
	"time"

	"github.com/kisshot/falky/server/internal/httpapi"
	"github.com/kisshot/falky/server/internal/platform"
)

const usage = `usage: falky <command>

commands:
  serve     run the server (applies pending migrations first)
  migrate   apply pending migrations and exit
`

// migrationSources lists the embedded migrations of each module that owns
// tables; platform applies them as one sequence ordered by version.
var migrationSources []fs.FS

// shutdownTimeout bounds how long serve waits for in-flight requests.
const shutdownTimeout = 10 * time.Second

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

// run executes the command in args and returns the process exit code.
func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		_, _ = fmt.Fprint(stderr, usage)
		return 2
	}
	var command func(context.Context, platform.Config, *slog.Logger) error
	switch args[0] {
	case "serve":
		command = serve
	case "migrate":
		command = migrate
	case "help", "-h", "--help":
		_, _ = fmt.Fprint(stdout, usage)
		return 0
	default:
		_, _ = fmt.Fprintf(stderr, "falky: unknown command %q\n\n%s", args[0], usage)
		return 2
	}

	cfg, err := platform.LoadConfig(getenv)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "falky: config: %v\n", err)
		return 1
	}
	logger := platform.NewLogger(stdout, cfg.LogLevel)
	if err := command(ctx, cfg, logger); err != nil {
		logger.Error("falky "+args[0]+" failed", "error", err)
		return 1
	}
	return 0
}

// openMigrated opens the database and applies pending migrations.
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
	return serveOn(ctx, logger, db, ms, publicLn, internalLn)
}

// serveOn serves both listeners until ctx is done or one of them fails, then
// shuts both down, letting in-flight requests finish.
func serveOn(ctx context.Context, logger *slog.Logger, db *platform.DB, ms platform.Migrations, publicLn, internalLn net.Listener) error {
	health := platform.NewHealth(logger)
	health.Require("database", func(ctx context.Context) error { return db.CheckMigrated(ctx, ms) })
	handlers := httpapi.New(httpapi.Deps{
		Logger:  logger,
		Health:  health,
		Metrics: platform.NewMetrics().Handler(),
	})

	errorLog := slog.NewLogLogger(logger.Handler(), slog.LevelWarn)
	servers := []struct {
		name string
		ln   net.Listener
		srv  *http.Server
	}{
		{"public", publicLn, &http.Server{Handler: handlers.Public, ReadHeaderTimeout: 10 * time.Second, ErrorLog: errorLog}},
		{"internal", internalLn, &http.Server{Handler: handlers.Internal, ReadHeaderTimeout: 10 * time.Second, ErrorLog: errorLog}},
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
