package platform

import (
	"log/slog"
	"strings"
	"testing"
)

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func TestLoadConfigDefaultsToLoopback(t *testing.T) {
	cfg, err := LoadConfig(env(nil))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	want := Config{
		PublicAddr:   "127.0.0.1:8080",
		InternalAddr: "127.0.0.1:9090",
		DBPath:       "falky.db",
		AdminSocket:  "falky-admin.sock",
		PublicOrigin: "http://127.0.0.1:8080",
		LogLevel:     slog.LevelInfo,
	}
	if cfg != want {
		t.Errorf("cfg = %+v, want %+v", cfg, want)
	}
}

func TestLoadConfigReadsEnvironment(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{
		EnvPublicAddr:   ":8080",
		EnvInternalAddr: ":9090",
		EnvDBPath:       "/data/falky.db",
		EnvAdminSocket:  "/run/falky/admin.sock",
		EnvPublicOrigin: "https://falky.example/",
		EnvLogLevel:     "debug",
	}))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	want := Config{
		PublicAddr:   ":8080",
		InternalAddr: ":9090",
		DBPath:       "/data/falky.db",
		AdminSocket:  "/run/falky/admin.sock",
		PublicOrigin: "https://falky.example",
		LogLevel:     slog.LevelDebug,
	}
	if cfg != want {
		t.Errorf("cfg = %+v, want %+v", cfg, want)
	}
}

func TestLoadConfigRefusesBadValues(t *testing.T) {
	for name, vars := range map[string]map[string]string{
		"unknown log level":     {EnvLogLevel: "loud"},
		"same address":          {EnvPublicAddr: ":8080", EnvInternalAddr: ":8080"},
		"origin without scheme": {EnvPublicOrigin: "falky.example"},
		"origin with a path":    {EnvPublicOrigin: "https://falky.example/app"},
		"origin with a query":   {EnvPublicOrigin: "https://falky.example/?a=b"},
		"origin not http":       {EnvPublicOrigin: "ftp://falky.example"},
		"plain http origin":     {EnvPublicOrigin: "http://falky.example"},
		"socket path too long":  {EnvAdminSocket: "/" + strings.Repeat("a", 107)},
		"abstract socket":       {EnvAdminSocket: "@falky"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadConfig(env(vars)); err == nil {
				t.Error("LoadConfig = nil error, want a refusal")
			}
		})
	}
}
