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
		PublicAddr:     "127.0.0.1:8080",
		InternalAddr:   "127.0.0.1:9090",
		DBPath:         "falky.db",
		AttachmentRoot: "attachments", AttachmentPostedBytes: 5_000_000_000,
		SnapshotDir:   "snapshots",
		AdminSocket:   "falky-admin.sock",
		PublicOrigin:  "http://127.0.0.1:8080",
		LogLevel:      slog.LevelInfo,
		LiveKitURL:    "ws://127.0.0.1:8080",
		LiveKitAPIURL: "http://127.0.0.1:7880",
		VoiceRoomCap:  8,
	}
	if cfg != want {
		t.Errorf("cfg = %+v, want %+v", cfg, want)
	}
}

func TestOptionalSignallingListener(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{"FALKY_SIGNALLING_ADDR": ":7880"}))
	if err != nil || cfg.SignallingAddr != ":7880" {
		t.Fatalf("signalling listener = %+v, %v", cfg, err)
	}
	for _, addr := range []string{"127.0.0.1:8080", "127.0.0.1:9090"} {
		if _, err := LoadConfig(env(map[string]string{"FALKY_SIGNALLING_ADDR": addr})); err == nil {
			t.Fatalf("conflicting listener %q accepted", addr)
		}
	}
}

func TestLoadConfigReadsEnvironment(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{
		EnvPublicAddr:       ":8080",
		EnvInternalAddr:     ":9090",
		EnvDBPath:           "/data/falky.db",
		EnvSnapshotDir:      "/snapshots",
		EnvAdminSocket:      "/run/falky/admin.sock",
		EnvPublicOrigin:     "https://falky.example/",
		EnvLogLevel:         "debug",
		EnvLiveKitURL:       "wss://voice.falky.example:7443",
		EnvLiveKitAPIURL:    "http://livekit:7880",
		EnvLiveKitAPIKey:    "falky",
		EnvLiveKitAPISecret: "a-secret-of-at-least-32-characters",
		EnvVoiceRoomCap:     "5",
	}))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	want := Config{
		PublicAddr:     ":8080",
		InternalAddr:   ":9090",
		DBPath:         "/data/falky.db",
		AttachmentRoot: "/data/attachments", AttachmentPostedBytes: 5_000_000_000,
		SnapshotDir:      "/snapshots",
		AdminSocket:      "/run/falky/admin.sock",
		PublicOrigin:     "https://falky.example",
		LogLevel:         slog.LevelDebug,
		LiveKitURL:       "wss://voice.falky.example:7443",
		LiveKitAPIURL:    "http://livekit:7880",
		LiveKitAPIKey:    "falky",
		LiveKitAPISecret: "a-secret-of-at-least-32-characters",
		VoiceRoomCap:     5,
	}
	if cfg != want {
		t.Errorf("cfg = %+v, want %+v", cfg, want)
	}
}

func TestLoadConfigRefusesBadValues(t *testing.T) {
	for name, vars := range map[string]map[string]string{
		"unknown log level":        {EnvLogLevel: "loud"},
		"same address":             {EnvPublicAddr: ":8080", EnvInternalAddr: ":8080"},
		"origin without scheme":    {EnvPublicOrigin: "falky.example"},
		"origin with a path":       {EnvPublicOrigin: "https://falky.example/app"},
		"origin with a query":      {EnvPublicOrigin: "https://falky.example/?a=b"},
		"origin not http":          {EnvPublicOrigin: "ftp://falky.example"},
		"plain http origin":        {EnvPublicOrigin: "http://falky.example"},
		"socket path too long":     {EnvAdminSocket: "/" + strings.Repeat("a", 107)},
		"abstract socket":          {EnvAdminSocket: "@falky"},
		"LiveKit URL not ws":       {EnvLiveKitURL: "https://falky.example"},
		"plain ws LiveKit URL":     {EnvLiveKitURL: "ws://falky.example"},
		"LiveKit URL with path":    {EnvLiveKitURL: "wss://falky.example/rtc"},
		"LiveKit API URL not http": {EnvLiveKitAPIURL: "ws://livekit:7880"},
		"room cap zero":            {EnvVoiceRoomCap: "0"},
		"room cap not a number":    {EnvVoiceRoomCap: "eight"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadConfig(env(vars)); err == nil {
				t.Error("LoadConfig = nil error, want a refusal")
			}
		})
	}
}

func TestLiveKitURLDefaultsToThePublicOrigin(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{EnvPublicOrigin: "https://falky.example"}))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.LiveKitURL != "wss://falky.example" {
		t.Errorf("LiveKitURL = %q, want wss://falky.example", cfg.LiveKitURL)
	}
}

func TestAttachmentConfigFollowsDatabaseAndValidatesQuota(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{EnvDBPath: "/data/falky.db"}))
	if err != nil || cfg.AttachmentRoot != "/data/attachments" || cfg.AttachmentPostedBytes != 5_000_000_000 {
		t.Fatalf("defaults=%+v %v", cfg, err)
	}
	cfg, err = LoadConfig(env(map[string]string{EnvAttachmentRoot: "/data/files", EnvAttachmentPostedBytes: "123"}))
	if err != nil || cfg.AttachmentRoot != "/data/files" || cfg.AttachmentPostedBytes != 123 {
		t.Fatalf("configured=%+v %v", cfg, err)
	}
	for _, value := range []string{"0", "-1", "bytes", "9223372036854775808"} {
		if _, err := LoadConfig(env(map[string]string{EnvAttachmentPostedBytes: value})); err == nil {
			t.Errorf("quota %q accepted", value)
		}
	}
}
