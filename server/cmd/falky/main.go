// Command falky runs the Falky server and its operator commands.
//
// Usage:
//
//	falky serve                     run the server (applies pending migrations first)
//	falky migrate                   apply pending migrations and exit
//	falky room create <name>        create a room in the running server and print its ID
//	falky room rename <id> <name>   rename a room in the running server
//	falky password set              set the access password people give before signing in
//	falky account list              list accounts as JSON
//	falky account disable|enable <login>
//	falky account recover <login>   issue a 30-minute recovery link
//	falky health live|ready         probe the running server's health and fail unless it is live or ready
//	falky snapshot                  have the running server snapshot its database and print where it went
//	falky restore                   make the snapshot on standard input the database; the server must be stopped
//
// Configuration comes from FALKY_* environment variables; see
// internal/platform.LoadConfig.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/kisshot/falky/server/internal/admin"
	"github.com/kisshot/falky/server/internal/attachments"
	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/httpapi"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/scheduler"
	"github.com/kisshot/falky/server/internal/voice"
	"golang.org/x/term"
)

const usage = `usage: falky <command>

commands:
  serve                     run the server (applies pending migrations first)
  migrate                   apply pending migrations and exit
  room create <name>        create a room in the running server and print its ID
  room rename <id> <name>   rename a room in the running server
  password set              set the access password, read from standard input; people give it
                            once per browser before they sign in or register
  account list              list accounts: IDs, logins, names and disabled status
  account disable <login>   disable an account and end its access (a login or an account ID)
  account enable <login>    let a disabled account sign in again
  account recover <login>   issue a 30-minute link to set a new password, after verifying the person
  health live|ready         probe the running server's health and fail unless it is live or ready
  snapshot                  have the running server snapshot its database and print where it went
  restore                   make the snapshot on standard input the database; the server must be stopped

Quote a name that has spaces: falky room create "Living room"
`

// migrationSources lists the embedded migrations of each module that owns
// tables; platform applies them as one sequence ordered by version.
var migrationSources = []fs.FS{identity.Migrations(), rooms.Migrations(), chat.Migrations(), attachments.Migrations(), voice.Migrations()}

// shutdownTimeout bounds how long serve waits for in-flight requests.
const shutdownTimeout = 10 * time.Second

// Signing in is limited per login to a burst of loginBurst attempts, then one
// more each loginInterval, on top of the per-address account limit.
const (
	loginBurst    = 10
	loginInterval = 30 * time.Second
)

// Creating and renaming rooms is limited per account to a burst of roomBurst
// changes, then one more each roomInterval.
const (
	roomBurst    = 5
	roomInterval = 12 * time.Second
)

// Posting is limited per visitor to a burst of postBurst messages, then one
// more each postInterval.
const (
	postBurst    = 10
	postInterval = time.Second
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Getenv, os.Stdin, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

// run executes the command in args and returns the process exit code.
// Server commands log JSON lines to stdout; operator commands print their
// result to stdout and their error to stderr.
func run(ctx context.Context, args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "__image-process" {
		return imageProcess(args, stdout)
	}
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
	case slices.Equal(args, []string{"password", "set"}):
		operator = func(ctx context.Context, cfg platform.Config, stdout io.Writer) error {
			return passwordSet(ctx, cfg, stdin, stdout)
		}
	case len(args) == 2 && args[0] == "health" && slices.Contains([]string{"live", "ready"}, args[1]):
		operator = func(ctx context.Context, cfg platform.Config, stdout io.Writer) error {
			return health(ctx, cfg, stdout, args[1])
		}
	case len(args) >= 2 && args[0] == "account" && ((len(args) == 2 && args[1] == "list") || (len(args) == 3 && slices.Contains([]string{"disable", "enable", "recover"}, args[1]))):
		command = strings.Join(args[:2], " ")
		operator = func(ctx context.Context, cfg platform.Config, out io.Writer) error {
			return accountCommand(ctx, cfg, out, args)
		}
	case slices.Equal(args, []string{"snapshot"}):
		operator = snapshot
	case slices.Equal(args, []string{"restore"}):
		operator = func(ctx context.Context, cfg platform.Config, stdout io.Writer) error {
			return restore(ctx, cfg, stdin, stdout)
		}
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

// snapshot has the running server snapshot its database and prints where the
// snapshot went.
func snapshot(ctx context.Context, cfg platform.Config, stdout io.Writer) error {
	path, err := admin.NewClient(cfg.AdminSocket).Snapshot(ctx)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, path)
	return err
}

// restore makes the snapshot read from stdin the database, which must not
// exist yet; the server starts on it next time.
func restore(ctx context.Context, cfg platform.Config, stdin io.Reader, stdout io.Writer) error {
	ms, err := platform.LoadMigrations(migrationSources...)
	if err != nil {
		return err
	}
	if err := platform.Restore(ctx, stdin, cfg.DBPath, ms); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "restored the snapshot as %s; start the server on it\n", cfg.DBPath)
	return err
}

// healthTimeout bounds the health command's request.
const healthTimeout = 5 * time.Second

// health asks the running server's internal listener whether it is live or
// ready (probe) and prints the report it answers with. It fails unless the
// answer is 200, so a container healthcheck can run it: the image has no
// shell or HTTP client of its own.
func health(ctx context.Context, cfg platform.Config, stdout io.Writer, probe string) error {
	host, port, err := net.SplitHostPort(cfg.InternalAddr)
	if err != nil {
		return fmt.Errorf("%s: %w", platform.EnvInternalAddr, err)
	}
	// A listener on every interface is reached on loopback.
	if ip := net.ParseIP(host); host == "" || ip != nil && ip.IsUnspecified() {
		host = "127.0.0.1"
	}
	url := "http://" + net.JoinHostPort(host, port) + "/health/" + probe
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	body, err := io.ReadAll(res.Body)
	if err := errors.Join(err, res.Body.Close()); err != nil {
		return fmt.Errorf("read %s: %w", url, err)
	}
	if _, err := stdout.Write(body); err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", url, res.Status)
	}
	return nil
}

// openMigrated opens the database, applies pending migrations and creates the
// access link if there is none yet.
func openMigrated(ctx context.Context, cfg platform.Config, logger *slog.Logger) (*platform.DB, platform.Migrations, error) {
	ms, err := platform.LoadMigrations(migrationSources...)
	if err != nil {
		return nil, platform.Migrations{}, err
	}
	db, err := platform.OpenDB(ctx, cfg.DBPath, logger)
	if err != nil {
		return nil, platform.Migrations{}, err
	}
	applied, err := db.Migrate(ctx, ms)
	if err != nil {
		return nil, platform.Migrations{}, errors.Join(err, db.Close())
	}
	logger.Info("database migrated", "path", cfg.DBPath, "applied", applied)
	set, err := identity.New(db, cfg.PublicOrigin).AccessPasswordSet(ctx)
	if err != nil {
		return nil, platform.Migrations{}, errors.Join(err, db.Close())
	}
	if !set {
		logger.Warn("no access password yet, so no one can sign in or register; set it with falky password set")
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
	ls := listeners{public: publicLn, internal: internalLn, admin: adminLn}
	if cfg.SignallingAddr != "" {
		ls.signalling, err = lc.Listen(ctx, "tcp", cfg.SignallingAddr)
		if err != nil {
			return errors.Join(fmt.Errorf("signalling listener: %w", err), ls.close())
		}
	}
	return serveOn(ctx, logger, cfg, db, ms, ls)
}

// listeners are where serveOn accepts connections.
type listeners struct {
	public, internal net.Listener
	signalling       net.Listener
	// admin is the Unix socket of the operator commands.
	admin net.Listener
}

func (ls listeners) close() error {
	var err error
	for _, listener := range []net.Listener{ls.public, ls.internal, ls.admin, ls.signalling} {
		if listener != nil {
			err = errors.Join(err, listener.Close())
		}
	}
	return err
}

// serveOn serves every listener until ctx is done or one of them fails, then
// shuts them all down, letting in-flight requests finish.
func serveOn(ctx context.Context, logger *slog.Logger, cfg platform.Config, db *platform.DB, ms platform.Migrations, ls listeners) error {
	health := platform.NewHealth(logger)
	health.Require("database", func(ctx context.Context) error { return db.CheckMigrated(ctx, ms) })
	ident := identity.New(db, cfg.PublicOrigin)
	if err := ident.InitializeColours(ctx); err != nil {
		return errors.Join(err, ls.close())
	}
	hub := realtime.New(realtime.WithLogger(logger), realtime.WithConnectedFunc(ident.ColourConnected))
	events := httpapi.Events{Hub: hub, Logger: logger}
	root := cfg.AttachmentRoot
	if root == "" {
		root = filepath.Join(filepath.Dir(cfg.DBPath), "attachments")
	}
	options := []attachments.Option{
		attachments.WithExpiryPublisher(events.AttachmentsExpired),
		attachments.WithErrorHandler(func(err error) { logger.Error("attachment cleanup failed", "error", err) }),
	}
	if cfg.AttachmentPostedBytes > 0 {
		options = append(options, attachments.WithPostedQuota(cfg.AttachmentPostedBytes))
	}
	store, err := attachments.New(db, root, options...)
	if err != nil {
		return errors.Join(err, ls.close())
	}
	if err := store.Recover(ctx); err != nil {
		return errors.Join(err, store.Close(context.Background()), ls.close())
	}
	defer func() { _ = store.Close(context.Background()) }()
	runCtx, stopRun := context.WithCancel(context.WithoutCancel(ctx))
	defer stopRun()
	rs := rooms.New(db, rooms.WithPublisher(events.RoomChanged), rooms.WithNameCheck(ident.NameTaken))
	vs := voice.New(voice.NewClient(cfg.LiveKitAPIURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret), ident, rs, voice.Config{
		URL: cfg.LiveKitURL, APIKey: cfg.LiveKitAPIKey, APISecret: cfg.LiveKitAPISecret, RoomCap: cfg.VoiceRoomCap,
	}, voice.WithDB(db), voice.WithPublisher(events.OccupancyChanged), voice.WithLogger(logger))
	health.Optional("livekit", vs.Check)
	lifecycle := &httpapi.Lifecycle{Enforce: httpapi.Enforcer(events, vs)}
	handlers := httpapi.New(httpapi.Deps{
		Lifecycle: lifecycle,
		Logger:    logger,
		Health:    health,
		Metrics:   platform.NewMetrics().Handler(),
		Identity:  ident,
		Rooms:     rs,
		Chat: chat.New(db,
			chat.WithAttachments(store),
			chat.WithPostLimit(platform.NewLimiter(postBurst, postInterval, time.Now)),
			chat.WithPublisher(events.MessageCreated)),
		Voice:         vs,
		LiveKitAPIURL: cfg.LiveKitAPIURL,
		LoginLimit:    platform.NewLimiter(loginBurst, loginInterval, time.Now),
		RoomLimit:     platform.NewLimiter(roomBurst, roomInterval, time.Now),
		Live:          hub,
		PublicOrigin:  cfg.PublicOrigin,
		Attachments:   store,
		Shutdown:      runCtx,
	})
	adminHandler := admin.Handler(admin.Deps{
		Lifecycle: lifecycle, Logger: logger, Identity: ident, Rooms: rs,
		DB: db, SnapshotDir: cfg.SnapshotDir,
	})

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
	if ls.signalling != nil {
		servers = append(servers, struct {
			name string
			ln   net.Listener
			srv  *http.Server
		}{"signalling", ls.signalling, &http.Server{Handler: handlers.Signalling, ReadHeaderTimeout: 10 * time.Second, ErrorLog: errorLog}})
	}
	scheduled := make(chan struct{})
	go func() {
		defer close(scheduled)
		scheduler.Run(runCtx,
			scheduler.Job{Interval: 20 * time.Second, Run: hub.Heartbeat},
			scheduler.Job{Interval: 30 * time.Second, Startup: true, Run: func(ctx context.Context) {
				operationCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				defer cancel()
				if err := lifecycle.Maintain(operationCtx, hub, vs); err != nil && ctx.Err() == nil {
					logger.WarnContext(ctx, "access maintenance failed", "error", err)
				}
			}},
			scheduler.Job{Interval: time.Minute, Run: func(ctx context.Context) {
				if err := store.Recover(ctx); err != nil && ctx.Err() == nil {
					logger.ErrorContext(ctx, "attachment cleanup failed", "error", err)
				}
			}},
		)
	}()
	errc := make(chan error, len(servers))
	for _, s := range servers {
		logger.Info("listening", "listener", s.name, "addr", s.ln.Addr().String())
		go func() { errc <- fmt.Errorf("%s listener: %w", s.name, s.srv.Serve(s.ln)) }()
	}

	err = nil
	select {
	case <-ctx.Done():
		logger.Info("shutting down")
	case err = <-errc:
	}
	stopRun()
	<-scheduled
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	closed := make(chan error, 1)
	go func() { closed <- store.Close(context.Background()) }()
	for _, s := range servers {
		if e := s.srv.Shutdown(shutdownCtx); e != nil {
			err = errors.Join(err, fmt.Errorf("shut down %s listener: %w", s.name, e))
			err = errors.Join(err, s.srv.Close())
		}
	}
	err = errors.Join(err, <-closed)
	// The servers do not track the WebSocket connections they handed over.
	if e := hub.Shutdown(shutdownCtx); e != nil {
		err = errors.Join(err, fmt.Errorf("shut down live updates: %w", e))
	}
	vs.CloseSignalling()
	if err == nil {
		logger.Info("stopped")
	}
	return err
}

func accountCommand(ctx context.Context, cfg platform.Config, out io.Writer, args []string) error {
	c := admin.NewClient(cfg.AdminSocket)
	switch args[1] {
	case "list":
		accounts, err := c.Accounts(ctx)
		if err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(accounts)
	case "disable":
		return c.DisableAccount(ctx, args[2])
	case "enable":
		return c.EnableAccount(ctx, args[2])
	case "recover":
		grant, err := c.IssueRecovery(ctx, args[2])
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(out, grant.Link)
		return err
	}
	return errors.New("unknown account command")
}

// passwordSet reads the access password from in and sets it on the running
// server. From a terminal it asks twice without echoing; otherwise it reads
// the first line, so the password never has to appear in a command line.
func passwordSet(ctx context.Context, cfg platform.Config, in io.Reader, out io.Writer) error {
	password, err := readPassword(in, out)
	if err != nil {
		return err
	}
	if err := admin.NewClient(cfg.AdminSocket).SetAccessPassword(ctx, password); err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, "access password set; browsers that gave the old one must give the new one before signing in again")
	return err
}

func readPassword(in io.Reader, out io.Writer) (string, error) {
	if f, ok := in.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		_, _ = fmt.Fprint(out, "Access password: ")
		first, err := term.ReadPassword(int(f.Fd()))
		_, _ = fmt.Fprintln(out)
		if err != nil {
			return "", err
		}
		_, _ = fmt.Fprint(out, "Again: ")
		second, err := term.ReadPassword(int(f.Fd()))
		_, _ = fmt.Fprintln(out)
		if err != nil {
			return "", err
		}
		if string(first) != string(second) {
			return "", errors.New("the passwords differ")
		}
		return string(first), nil
	}
	line, err := bufio.NewReader(io.LimitReader(in, 4096)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return "", errors.New("no password on standard input")
	}
	return line, nil
}
