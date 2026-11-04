// Command smoke checks a running Falky Compose stack end to end, through Caddy,
// the way a client would: entering, live updates, chat, voice with LiveKit and
// its webhooks, a name conflict, replacing the access link, and the limit on
// entering. It prints one line per check and exits non-zero on the first
// failure.
//
// Usage, from the repository root with the stack up:
//
//	make smoke
//	cd server && go run ./cmd/smoke [-compose ../deploy/compose.yaml]
//
// It runs the operator commands in the server's container with docker
// compose, trusts Caddy's local authority (so the stack must serve a local
// domain such as localhost), and joins voice from this machine. It replaces
// the access link, which ends every visitor's access, and leaves its rooms
// and visitors behind: run it only against a stack nobody uses.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/kisshot/falky/server/internal/api"
)

func main() {
	compose := flag.String("compose", "../deploy/compose.yaml", "the stack's Compose file")
	flag.Parse()
	if flag.NArg() != 0 {
		flag.Usage()
		os.Exit(2)
	}
	// The LiveKit client logs every step of connecting; the checks report
	// what matters.
	lksdk.SetLogger(logger.GetDiscardLogger())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, *compose, os.Stdout)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "smoke:", err)
		os.Exit(1)
	}
}

// run connects to the stack described by compose and runs every check in
// order, stopping at the first failure.
func run(ctx context.Context, compose string, out io.Writer) error {
	dir, err := os.MkdirTemp("", "falky-smoke-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	st, err := connect(ctx, compose, filepath.Join(dir, "ca.crt"))
	if err != nil {
		return err
	}
	s := &smoke{stack: st, out: out, suffix: randomHex(3)}
	defer s.close()
	_, _ = fmt.Fprintf(out, "checking the stack at %s\n", st.origin)
	for _, c := range s.checks() {
		start := time.Now()
		if err := c.run(ctx); err != nil {
			_, _ = fmt.Fprintf(out, "FAIL %s\n", c.name)
			return fmt.Errorf("%s: %w", c.name, err)
		}
		_, _ = fmt.Fprintf(out, "ok   %s (%s)\n", c.name, time.Since(start).Round(time.Millisecond))
	}
	_, _ = fmt.Fprintln(out, "PASS")
	return nil
}

// check is one step of the smoke test; later checks build on earlier ones.
type check struct {
	name string
	run  func(context.Context) error
}

// smoke holds what the checks share: the stack, and the visitors, room and
// connections earlier checks set up.
type smoke struct {
	*stack
	out io.Writer
	// suffix keeps this run's room and names apart from earlier runs'.
	suffix string

	secret  string // the access link's secret
	roomID  string
	ann     *visitor // in voice and live updates until the link is replaced
	annLive *liveConn
	// creds are Ann's latest voice credentials, and voice her current voice
	// connection, or nil.
	creds *api.VoiceCredentials
	voice *voiceConn
	// nia enters with the replaced link.
	nia *visitor
}

func (s *smoke) checks() []check {
	return []check{
		{"falky link show prints the access link", s.linkShow},
		{"falky room create creates a room", s.roomCreate},
		{"entering sets the visitor cookie and /api/me returns the visitor", s.enter},
		{"live updates refuse a foreign Origin", s.foreignOrigin},
		{"a message reaches live updates as message.created within a second", s.post},
		{"renaming the room reaches live updates as room.changed", s.renameRoom},
		{"joining voice sends occupancy.changed through LiveKit's webhook", s.joinVoice},
		{"a second connection with the same token replaces the first", s.replace},
		{"leaving voice sends occupancy.changed with the room empty", s.leaveVoice},
		{"a returning visitor whose name was taken is told and kept out", s.nameConflict},
		{"falky link rotate ends live updates, cookies and voice within two seconds", s.rotate},
		{"live updates stay open through Caddy past the server's 20-second ping", s.idle},
		{"wrong secrets hit the enter limit, and X-Forwarded-For does not escape it", s.enterLimit},
	}
}

// close ends the connections a failed run leaves open.
func (s *smoke) close() {
	if s.annLive != nil {
		s.annLive.close()
	}
	if s.voice != nil {
		s.voice.leave()
	}
}

// logf reports a detail of the current check, indented under it.
func (s *smoke) logf(format string, args ...any) {
	_, _ = fmt.Fprintf(s.out, "       "+format+"\n", args...)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// within waits up to d for ch, and fails with what when it does not come or
// d is already spent.
func within[T any](ctx context.Context, d time.Duration, ch <-chan T, what string) (T, error) {
	if d <= 0 {
		var zero T
		return zero, fmt.Errorf("%s: no time left", what)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case v := <-ch:
		return v, nil
	case <-timer.C:
		var zero T
		return zero, fmt.Errorf("%s: not within %s", what, d)
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	}
}
