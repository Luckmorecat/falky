package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/kisshot/falky/server/internal/platform"

	"github.com/kisshot/falky/server/internal/voice"
)

// maxWebhookBody bounds the body of a LiveKit webhook, which describes one
// room and participant.
const maxWebhookBody = 1 << 20

// liveKitWebhook serves POST /livekit/webhook, which the contract describes
// but the generated server leaves out: voice verifies the signature over the
// body as LiveKit sent it.
type liveKitWebhook struct {
	voice  *voice.Service
	logger *slog.Logger
}

func (h liveKitWebhook) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	err := h.voice.ReceiveWebhook(r)
	errs := errorWriter{logger: h.logger.With("operation", "livekit_webhook")}
	switch {
	case errors.Is(err, voice.ErrUnverifiedWebhook):
		h.logger.WarnContext(r.Context(), "LiveKit webhook refused", "error_kind", platform.ErrorKind(err))
		writeError(w, http.StatusUnauthorized, "webhook_unverified", "the request is not signed with the LiveKit API key")
	case errors.Is(err, voice.ErrInvalidWebhook):
		errs.badRequest(w, r, err)
	case err != nil:
		errs.internal(w, r, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
