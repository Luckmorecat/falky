package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	attachmentimage "github.com/kisshot/falky/server/internal/attachments/image"
	"golang.org/x/image/webp"
)

func TestImageWorkerDispatchDoesNotLoadServerConfig(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	output := filepath.Join(dir, "output")
	src := image.NewNRGBA(image.Rect(0, 0, 64, 32))
	src.SetNRGBA(10, 10, color.NRGBA{R: 255, A: 128})
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, src); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := run(t.Context(), []string{attachmentimage.WorkerCommand, source, output}, func(string) string { t.Fatal("worker loaded server config"); return "" }, nil, &stdout, &stderr)
	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("exit %d: %s", code, &stderr)
	}
	var response struct {
		Result attachmentimage.Result
		Error  string
	}
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Error != "" || response.Result.Width != 64 || response.Result.Height != 32 || response.Result.ContentType != "image/webp" {
		t.Fatalf("response: %+v", response)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := webp.Decode(bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if code := run(t.Context(), []string{attachmentimage.WorkerCommand}, func(string) string { t.Fatal("invalid worker loaded config"); return "" }, nil, &stdout, &stderr); code != 2 {
		t.Fatalf("invalid args exit %d", code)
	}
}
