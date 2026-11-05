package platform

import (
	"bufio"
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
)

type requestIDKey struct{}

// RequestID returns the server-generated correlation ID, or empty outside HTTP.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// ObserveHTTP correlates request logs and responses. Only public requests have
// routine completion records; internal probes stay quiet. Routes must be static
// templates: the allowlist also keeps mux redirects and unknown URLs private.
func ObserveHTTP(logger *slog.Logger, next http.Handler, listener string, routes ...string) http.Handler {
	allowed := make(map[string]bool, len(routes))
	for _, route := range routes {
		allowed[route] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		id := ulid.Make().String()
		r = r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id))
		w.Header().Set("X-Request-ID", id)
		finished := false
		finish := func(status int) {
			if finished {
				return
			}
			finished = true
			if listener != "public" {
				return
			}
			route := r.Pattern
			if _, path, ok := strings.Cut(route, " "); ok {
				route = path
			}
			if !allowed[route] {
				route = "unmatched"
			}
			method := r.Method
			switch method {
			case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE":
			default:
				method = "OTHER"
			}
			attrs := []any{"listener", listener, "method", method, "route", route, "status", status, "duration_ms", float64(time.Since(started)) / float64(time.Millisecond)}
			if status == 401 || status == 403 || status == 429 {
				if ip := forwardedIP(r); ip != "" {
					attrs = append(attrs, "client_ip", ip)
				}
			}
			logger.InfoContext(r.Context(), "http request completed", attrs...)
		}
		rw := &observedResponse{ResponseWriter: w, finish: finish}
		defer func() {
			status := rw.status
			if status == 0 {
				status = http.StatusOK
			}
			finish(status)
		}()
		next.ServeHTTP(rw, r)
	})
}

// forwardedIP trusts only Caddy's final entry. Unlike the limiter's IPv6 /64
// grouping this is the actual address; malformed input is never logged.
func forwardedIP(r *http.Request) string {
	values := r.Header.Values("X-Forwarded-For")
	if len(values) == 0 {
		return ""
	}
	last := values[len(values)-1]
	last = strings.TrimSpace(last[strings.LastIndexByte(last, ',')+1:])
	addr, err := netip.ParseAddr(last)
	if err != nil || addr.Zone() != "" {
		return ""
	}
	return addr.Unmap().String()
}

type observedResponse struct {
	http.ResponseWriter
	status int
	finish func(int)
}

// Unwrap keeps ResponseController's optional interfaces (including flush and
// hijack) available through this observer.
func (w *observedResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *observedResponse) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.ResponseWriter.WriteHeader(status)
	if status >= 200 || status == http.StatusSwitchingProtocols {
		w.status = status
		// WebSocket handlers run for the connection's entire lifetime. Record the
		// upgrade duration now, rather than counting that as an HTTP request.
		if status == http.StatusSwitchingProtocols {
			w.finish(status)
		}
	}
}

func (w *observedResponse) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

func (w *observedResponse) Flush() {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *observedResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}
