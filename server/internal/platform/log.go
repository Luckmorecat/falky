package platform

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"strconv"
	"syscall"

	"github.com/twitchtv/twirp"
)

// NewLogger returns a logger that writes JSON lines at level and above to w.
// Context logging automatically includes the server's HTTP correlation ID.
func NewLogger(w io.Writer, level slog.Level) *slog.Logger {
	return slog.New(correlatedHandler{slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})})
}

type correlatedHandler struct{ slog.Handler }

func (h correlatedHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("request_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

func (h correlatedHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return correlatedHandler{h.Handler.WithAttrs(attrs)}
}

func (h correlatedHandler) WithGroup(name string) slog.Handler {
	return correlatedHandler{h.Handler.WithGroup(name)}
}

// ErrorKind classifies failures without serializing error messages, which may
// contain credentials, names, URLs, or data returned by an external service.
func ErrorKind(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, fs.ErrExist):
		return "already_exists"
	case errors.Is(err, fs.ErrPermission):
		return "permission_denied"
	case errors.Is(err, fs.ErrNotExist):
		return "not_found"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection_refused"
	}
	var sqlite interface{ Code() int }
	if errors.As(err, &sqlite) {
		return "sqlite_" + strconv.Itoa(sqlite.Code())
	}
	var rpc twirp.Error
	if errors.As(err, &rpc) && twirp.IsValidErrorCode(rpc.Code()) {
		return "livekit_" + string(rpc.Code())
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "dns"
	}
	var network net.Error
	if errors.As(err, &network) {
		if network.Timeout() {
			return "timeout"
		}
		return "network"
	}
	return "internal"
}
