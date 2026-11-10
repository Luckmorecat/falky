// Package httpapi serves the HTTP contract in api/openapi.yaml. It translates
// between HTTP and the modules and holds no business logic.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/attachments"
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
	Internal   http.Handler
	Signalling http.Handler
}

// maxRequestBody bounds the body of a public request, so that no one can make
// the server buffer an arbitrarily large one.
const maxRequestBody = 64 << 10

// Deps are what the handlers serve from.
type Deps struct {
	Logger      *slog.Logger
	Health      *platform.Health
	Metrics     http.Handler
	Identity    *identity.Service
	Lifecycle   *Lifecycle
	AuthLimit   *platform.Limiter
	Rooms       *rooms.Service
	Chat        *chat.Service
	Attachments *attachments.Store
	// Shutdown wakes blocked upload readers before the application waits for Store.Close.
	Shutdown      context.Context
	Voice         *voice.Service
	LiveKitAPIURL string
	// LoginLimit limits sign-in attempts per login, on top of AuthLimit's
	// limit per client IP. Posting is limited by Chat, which knows whether it
	// only repeats a stored message.
	LoginLimit *platform.Limiter
	// RoomLimit limits creating and renaming rooms per account.
	RoomLimit *platform.Limiter
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
	if deps.Lifecycle == nil {
		deps.Lifecycle = &Lifecycle{}
	}
	if deps.Lifecycle.Enforce == nil {
		deps.Lifecycle.Enforce = Enforcer(Events{Hub: deps.Live, Logger: deps.Logger}, deps.Voice)
	}
	if deps.Voice != nil && deps.Identity != nil {
		deps.Voice.ConfigureAdmission(deps.Lifecycle, deps.Identity.ValidateSession, deps.PublicOrigin)
	}
	if deps.AuthLimit == nil {
		deps.AuthLimit = platform.NewLimiter(20, 3*time.Second, time.Now)
	}
	s := &server{
		lifecycle:    deps.Lifecycle,
		logger:       deps.Logger,
		health:       deps.Health,
		identity:     deps.Identity,
		rooms:        deps.Rooms,
		chat:         deps.Chat,
		voice:        deps.Voice,
		loginLimit:   deps.LoginLimit,
		roomLimit:    deps.RoomLimit,
		publicOrigin: deps.PublicOrigin,
		events:       Events{Hub: deps.Live, Logger: deps.Logger},
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
	a := attachmentHandlers{store: deps.Attachments, rooms: deps.Rooms, resolve: resolve, origin: deps.PublicOrigin, errs: errs, shutdown: deps.Shutdown}
	public.HandleFunc("POST /api/rooms/{id}/attachments", attachmentRoute(a.upload))
	public.HandleFunc("GET /api/attachments/limits", attachmentRoute(a.limits))
	public.HandleFunc("GET /api/attachments/{id}", attachmentRoute(a.status))
	public.HandleFunc("DELETE /api/attachments/{id}", attachmentRoute(a.cancel))
	public.HandleFunc("GET /api/attachments/{id}/content", attachmentRoute(a.content))
	public.Handle("GET /api/live", live{
		origin: deps.PublicOrigin, resolve: resolve, identity: deps.Identity, rooms: deps.Rooms, hub: deps.Live,
		logger: deps.Logger, lifecycle: deps.Lifecycle,
	})
	var signalling http.Handler = http.HandlerFunc(notFound)
	if deps.Voice != nil {
		signalling = deps.Voice.Signalling(deps.LiveKitAPIURL)
	}
	public.Handle("/rtc", signalling)
	public.Handle("/rtc/", signalling)
	public.Handle("/api/", http.MaxBytesHandler(operations, maxRequestBody))
	public.Handle("/", http.MaxBytesHandler(http.HandlerFunc(notFound), maxRequestBody))

	internal := http.NewServeMux()
	internal.Handle("/health/", operations)
	internal.Handle("GET /metrics", deps.Metrics)
	internal.Handle("POST /livekit/webhook",
		http.MaxBytesHandler(liveKitWebhook{voice: deps.Voice, logger: deps.Logger}, maxWebhookBody))
	internal.HandleFunc("/", notFound)

	return Handlers{Public: accountProtection(public, deps.PublicOrigin, deps.AuthLimit), Internal: internal, Signalling: signalling}
}

type server struct {
	lifecycle    *Lifecycle
	events       Events
	logger       *slog.Logger
	health       *platform.Health
	identity     *identity.Service
	rooms        *rooms.Service
	chat         *chat.Service
	voice        *voice.Service
	loginLimit   *platform.Limiter
	roomLimit    *platform.Limiter
	publicOrigin string
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
	e.logger.ErrorContext(r.Context(), "request failed", "method", r.Method, "path", r.URL.Path, "error", err)
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
