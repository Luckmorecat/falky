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
	// AdminSocket is the path of the Unix socket the operator commands use to
	// reach the running server.
	AdminSocket string
	// PublicOrigin is where visitors reach the server, as scheme://host[:port]
	// with no trailing slash; the access link is built on it.
	PublicOrigin string
	// LogLevel is the minimum level written to the log.
	LogLevel slog.Level
}

// Environment variables read by LoadConfig.
const (
	EnvPublicAddr   = "FALKY_PUBLIC_ADDR"
	EnvInternalAddr = "FALKY_INTERNAL_ADDR"
	EnvDBPath       = "FALKY_DB_PATH"
	EnvAdminSocket  = "FALKY_ADMIN_SOCKET"
	EnvPublicOrigin = "FALKY_PUBLIC_ORIGIN"
	EnvLogLevel     = "FALKY_LOG_LEVEL"
)

// maxSocketPath is the longest Unix socket path Linux accepts.
const maxSocketPath = 107

// LoadConfig reads the configuration through getenv, using defaults for unset
// or empty variables. Both listeners default to loopback, and the public
// origin to the public listener's default address.
func LoadConfig(getenv func(string) string) (Config, error) {
	cfg := Config{
		PublicAddr:   valueOr(getenv(EnvPublicAddr), "127.0.0.1:8080"),
		InternalAddr: valueOr(getenv(EnvInternalAddr), "127.0.0.1:9090"),
		DBPath:       valueOr(getenv(EnvDBPath), "falky.db"),
		AdminSocket:  valueOr(getenv(EnvAdminSocket), "falky-admin.sock"),
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(valueOr(getenv(EnvLogLevel), "info"))); err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvLogLevel, err)
	}
	origin, err := parseOrigin(valueOr(getenv(EnvPublicOrigin), "http://127.0.0.1:8080"))
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvPublicOrigin, err)
	}
	cfg.PublicOrigin = origin
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

// parseOrigin accepts an https URL with a host and nothing after it but an
// optional "/", and returns it as scheme://host. Plain http is accepted for a
// loopback host only, for running locally without the reverse proxy.
func parseOrigin(s string) (string, error) {
	u, err := url.Parse(s)
	if err != nil {
		return "", err
	}
	loopback := slices.Contains([]string{"localhost", "127.0.0.1", "::1"}, u.Hostname())
	secure := u.Scheme == "https" || u.Scheme == "http" && loopback
	if !secure || u.Host == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return "", fmt.Errorf("%q is not an origin like https://falky.example (http only for a loopback host)", s)
	}
	return u.Scheme + "://" + u.Host, nil
}

func valueOr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
