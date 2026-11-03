// Package platform provides what every module shares at run time:
// configuration, logging, the SQLite database and its migrations, metrics and
// health checks.
package platform

import (
	"errors"
	"fmt"
	"log/slog"
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
	// LogLevel is the minimum level written to the log.
	LogLevel slog.Level
}

// Environment variables read by LoadConfig.
const (
	EnvPublicAddr   = "FALKY_PUBLIC_ADDR"
	EnvInternalAddr = "FALKY_INTERNAL_ADDR"
	EnvDBPath       = "FALKY_DB_PATH"
	EnvLogLevel     = "FALKY_LOG_LEVEL"
)

// LoadConfig reads the configuration through getenv, using defaults for unset
// or empty variables. Both listeners default to loopback.
func LoadConfig(getenv func(string) string) (Config, error) {
	cfg := Config{
		PublicAddr:   valueOr(getenv(EnvPublicAddr), "127.0.0.1:8080"),
		InternalAddr: valueOr(getenv(EnvInternalAddr), "127.0.0.1:9090"),
		DBPath:       valueOr(getenv(EnvDBPath), "falky.db"),
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(valueOr(getenv(EnvLogLevel), "info"))); err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvLogLevel, err)
	}
	if cfg.PublicAddr == cfg.InternalAddr {
		return Config{}, errors.New(EnvPublicAddr + " and " + EnvInternalAddr + " must differ")
	}
	return cfg, nil
}

func valueOr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
