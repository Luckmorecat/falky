// Package platform provides what every module shares at run time:
// configuration, logging, the SQLite database and its migrations, metrics and
// health checks.
package platform

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// Config is the server's configuration, read from the environment.
type Config struct {
	// PublicAddr is where the public listener (the API behind the reverse
	// proxy) accepts connections.
	PublicAddr string
	// InternalAddr is where the internal listener (health, metrics) accepts
	// connections. It must not be reachable from outside the deployment.
	InternalAddr string
	// DBPath is the SQLite database file.
	DBPath string
	// SnapshotDir is the directory the snapshots of the database go to.
	SnapshotDir string
	// AdminSocket is the path of the Unix socket the operator commands use to
	// reach the running server.
	AdminSocket string
	// PublicOrigin is where visitors reach the server, as scheme://host[:port]
	// with no trailing slash; the access link is built on it.
	PublicOrigin string
	// LogLevel is the minimum level written to the log.
	LogLevel slog.Level
	// LiveKitURL is where clients reach LiveKit, as ws://host or
	// wss://host[:port]; it is handed to them with each voice token.
	LiveKitURL string
	// LiveKitAPIURL is where the server reaches LiveKit's API, as
	// http(s)://host[:port]. It need not be reachable from outside.
	LiveKitAPIURL string
	// LiveKitAPIKey and LiveKitAPISecret sign voice tokens and the server's
	// requests to LiveKit. The secret is never logged or sent to clients.
	LiveKitAPIKey, LiveKitAPISecret string
	// VoiceRoomCap is the most participants a room's voice admits.
	VoiceRoomCap int
}

// Environment variables read by LoadConfig.
const (
	EnvPublicAddr   = "FALKY_PUBLIC_ADDR"
	EnvInternalAddr = "FALKY_INTERNAL_ADDR"
	EnvDBPath       = "FALKY_DB_PATH"
	EnvSnapshotDir  = "FALKY_SNAPSHOT_DIR"
	EnvAdminSocket  = "FALKY_ADMIN_SOCKET"
	EnvPublicOrigin = "FALKY_PUBLIC_ORIGIN"
	EnvLogLevel     = "FALKY_LOG_LEVEL"

	EnvLiveKitURL       = "FALKY_LIVEKIT_URL"
	EnvLiveKitAPIURL    = "FALKY_LIVEKIT_API_URL"
	EnvLiveKitAPIKey    = "FALKY_LIVEKIT_API_KEY"
	EnvLiveKitAPISecret = "FALKY_LIVEKIT_API_SECRET"
	EnvVoiceRoomCap     = "FALKY_VOICE_ROOM_CAP"
)

// maxSocketPath is the longest Unix socket path Linux accepts.
const maxSocketPath = 107

// defaultVoiceRoomCap is the most participants a room's voice admits unless
// configured otherwise.
const defaultVoiceRoomCap = 8

// LoadConfig reads the configuration through getenv, using defaults for unset
// or empty variables. Both listeners default to loopback, and the public
// origin to the public listener's default address. LiveKit defaults to being
// reached by clients at the public origin (the reverse proxy forwards its
// signalling) and by the server on loopback, as livekit-server --dev listens;
// the API key and secret have no default.
func LoadConfig(getenv func(string) string) (Config, error) {
	cfg := Config{
		PublicAddr:       valueOr(getenv(EnvPublicAddr), "127.0.0.1:8080"),
		InternalAddr:     valueOr(getenv(EnvInternalAddr), "127.0.0.1:9090"),
		DBPath:           valueOr(getenv(EnvDBPath), "falky.db"),
		SnapshotDir:      valueOr(getenv(EnvSnapshotDir), "snapshots"),
		AdminSocket:      valueOr(getenv(EnvAdminSocket), "falky-admin.sock"),
		LiveKitAPIKey:    getenv(EnvLiveKitAPIKey),
		LiveKitAPISecret: getenv(EnvLiveKitAPISecret),
		VoiceRoomCap:     defaultVoiceRoomCap,
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(valueOr(getenv(EnvLogLevel), "info"))); err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvLogLevel, err)
	}
	origin, err := parseRootURL(valueOr(getenv(EnvPublicOrigin), "http://127.0.0.1:8080"), "https", "http", false)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvPublicOrigin, err)
	}
	cfg.PublicOrigin = origin
	// The origin's scheme is https or http, so this is wss or ws.
	cfg.LiveKitURL, err = parseRootURL(valueOr(getenv(EnvLiveKitURL), "ws"+strings.TrimPrefix(origin, "http")), "wss", "ws", false)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvLiveKitURL, err)
	}
	cfg.LiveKitAPIURL, err = parseRootURL(valueOr(getenv(EnvLiveKitAPIURL), "http://127.0.0.1:7880"), "https", "http", true)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvLiveKitAPIURL, err)
	}
	if v := getenv(EnvVoiceRoomCap); v != "" {
		cfg.VoiceRoomCap, err = strconv.Atoi(v)
		if err != nil || cfg.VoiceRoomCap < 1 {
			return Config{}, fmt.Errorf("%s: %q is not a positive whole number", EnvVoiceRoomCap, v)
		}
	}
	if strings.HasPrefix(cfg.AdminSocket, "@") {
		// Go would bind a Linux abstract socket, which has no file
		// permissions.
		return Config{}, fmt.Errorf("%s: %q must be a file path, not an abstract socket", EnvAdminSocket, cfg.AdminSocket)
	}
	if len(cfg.AdminSocket) > maxSocketPath {
		return Config{}, fmt.Errorf("%s: %q is %d bytes, longer than the %d a Unix socket path allows",
			EnvAdminSocket, cfg.AdminSocket, len(cfg.AdminSocket), maxSocketPath)
	}
	if cfg.PublicAddr == cfg.InternalAddr {
		return Config{}, errors.New(EnvPublicAddr + " and " + EnvInternalAddr + " must differ")
	}
	return cfg, nil
}

// parseRootURL accepts a URL that is a scheme and a host, with nothing after
// the host but an optional "/", and returns it as scheme://host. The scheme
// is secure (such as https), or plain (such as http) for a loopback host,
// which is how the server runs locally without the reverse proxy. With
// plainAnywhere, plain is accepted for any host.
func parseRootURL(s, secure, plain string, plainAnywhere bool) (string, error) {
	u, err := url.Parse(s)
	if err != nil {
		return "", err
	}
	plainOK := plainAnywhere || slices.Contains([]string{"localhost", "127.0.0.1", "::1"}, u.Hostname())
	if u.Scheme != secure && (u.Scheme != plain || !plainOK) || u.Host == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		if plainAnywhere {
			return "", fmt.Errorf("%q is not a URL like %s://falky.example or %s://falky.example", s, secure, plain)
		}
		return "", fmt.Errorf("%q is not a URL like %s://falky.example (%s only for a loopback host)", s, secure, plain)
	}
	return u.Scheme + "://" + u.Host, nil
}

func valueOr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
