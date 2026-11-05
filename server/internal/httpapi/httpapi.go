// Package httpapi serves the HTTP contract in api/openapi.yaml. It translates
// between HTTP and the modules and holds no business logic.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/chat"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/platform"
	"github.com/kisshot/falky/server/internal/realtime"
	"github.com/kisshot/falky/server/internal/rooms"
	"github.com/kisshot/falky/server/internal/voice"
)

// Handlers are the handlers of the two listeners.
type Handlers struct {
	// Public serves /api/; it sits behind the reverse proxy.
	Public http.Handler
	// Internal serves health checks, metrics and LiveKit's webhooks; it is
	// never exposed.
	Internal http.Handler
}

// maxRequestBody bounds the body of a public request, so that no one can make
// the server buffer an arbitrarily large one.
const maxRequestBody = 64 << 10

// Deps are what the handlers serve from.
type Deps struct {
	Logger   *slog.Logger
	Health   *platform.Health
	Metrics  http.Handler
	Identity *identity.Service
	Rooms    *rooms.Service
	Chat     *chat.Service
	Voice    *voice.Service
	// EnterLimit limits entering per client IP. Posting is limited by Chat,
	// which knows whether it only repeats a stored message.
	EnterLimit *platform.Limiter
	// Live is the hub GET /api/live connects to; the modules publish to it
	// through Events.
	Live *realtime.Hub
	// PublicOrigin is where visitors reach the server, as scheme://host; a
	// live-update connection from any other origin is refused.
	PublicOrigin string
}

// New returns the handlers of both listeners. Every operation of the contract
// is routed on one mux; each listener forwards only its own path prefixes to
// it, so an operation is reachable on exactly one listener.
func New(deps Deps) Handlers {
	s := &server{
		logger:     deps.Logger,
		health:     deps.Health,
		identity:   deps.Identity,
		rooms:      deps.Rooms,
		chat:       deps.Chat,
		voice:      deps.Voice,
		enterLimit: deps.EnterLimit,
	}
	errs := errorWriter{logger: deps.Logger}
	resolve := visitorResolver{identity: deps.Identity, errs: errs}

	operations := http.NewServeMux()
	operations.HandleFunc("/", notFound)
	api.HandlerWithOptions(
		api.NewStrictHandlerWithOptions(s, []api.StrictMiddlewareFunc{resolve.middleware}, api.StrictHTTPServerOptions{
			RequestErrorHandlerFunc:  errs.badRequest,
			ResponseErrorHandlerFunc: errs.internal,
		}),
		api.StdHTTPServerOptions{BaseRouter: operations, ErrorHandlerFunc: errs.badRequest},
	)

	public := http.NewServeMux()
	public.Handle("GET /api/live", live{
		origin: deps.PublicOrigin, resolve: resolve, identity: deps.Identity, rooms: deps.Rooms, hub: deps.Live,
		logger: deps.Logger,
	})
	public.Handle("/api/", operations)
	public.HandleFunc("/", notFound)

	internal := http.NewServeMux()
	internal.Handle("/health/", operations)
	internal.Handle("GET /metrics", deps.Metrics)
	internal.Handle("POST /livekit/webhook",
		http.MaxBytesHandler(liveKitWebhook{voice: deps.Voice, logger: deps.Logger}, maxWebhookBody))
	internal.HandleFunc("/", notFound)

	// MaxBytesHandler copies the request, so observe inside it to see the
	// final mux pattern without retaining an arbitrary URL.
	return Handlers{
		Public: http.MaxBytesHandler(platform.ObserveHTTP(deps.Logger, public, "public",
			"/api/enter", "/api/me", "/api/rooms", "/api/rooms/{id}/messages", "/api/rooms/{id}/voice", "/api/live"), maxRequestBody),
		Internal: platform.ObserveHTTP(deps.Logger, internal, "internal"),
	}
}

type server struct {
	logger     *slog.Logger
	health     *platform.Health
	identity   *identity.Service
	rooms      *rooms.Service
	chat       *chat.Service
	voice      *voice.Service
	enterLimit *platform.Limiter
}

var _ api.StrictServerInterface = (*server)(nil)

func (s *server) GetLiveness(context.Context, api.GetLivenessRequestObject) (api.GetLivenessResponseObject, error) {
	return api.GetLiveness200JSONResponse{Status: api.HealthStatusOk}, nil
}

func (s *server) GetReadiness(ctx context.Context, _ api.GetReadinessRequestObject) (api.GetReadinessResponseObject, error) {
	report := s.health.Check(ctx)
	body := api.Health{
		Status:     api.HealthStatus(report.Status),
		Components: make(map[string]api.HealthStatus, len(report.Components)),
	}
	for name, status := range report.Components {
		body.Components[name] = api.HealthStatus(status)
	}
	if !report.Ready() {
		return api.GetReadiness503JSONResponse(body), nil
	}
	return api.GetReadiness200JSONResponse(body), nil
}

type errorWriter struct {
	logger *slog.Logger
}

func (e errorWriter) badRequest(w http.ResponseWriter, _ *http.Request, err error) {
	writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
}

func (e errorWriter) internal(w http.ResponseWriter, r *http.Request, err error) {
	e.logger.ErrorContext(r.Context(), "request failed", "error_kind", platform.ErrorKind(err))
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "not_found", "no such route")
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.Error{Code: code, Message: message})
}
