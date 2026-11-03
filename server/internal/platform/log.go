package platform

import (
	"io"
	"log/slog"
)

// NewLogger returns a logger that writes JSON lines at level and above to w.
func NewLogger(w io.Writer, level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level}))
}
