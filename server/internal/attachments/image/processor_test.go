package image_test

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/image/webp"

	attachmentimage "github.com/kisshot/falky/server/internal/attachments/image"
)

func TestUnsupportedRemainsUnchanged(t *testing.T) {
	for _, data := range []string{"GIF89a unchanged metadata", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>active()</script></svg>", "arbitrary file"} {
		t.Run(data[:3], func(t *testing.T) {
			dir := t.TempDir()
			source := filepath.Join(dir, "source")
			output := filepath.Join(dir, "output")
			if err := os.WriteFile(source, []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
			result, err := attachmentimage.NewProcessor().Process(context.Background(), source, output)
			if err != nil {
				t.Fatal(err)
			}
			if result.Optimized || result.Inline || result.Size != int64(len(data)) {
				t.Fatalf("result: %+v", result)
			}
			original, err := os.ReadFile(source)
			if err != nil || string(original) != data {
				t.Fatalf("source changed: %v", err)
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatalf("unexpected output: %v", err)
			}
		})
	}
}

func TestMain(m *testing.M) {
	if len(os.Args) == 4 && os.Args[1] == attachmentimage.WorkerCommand {
		// A stalled external worker exercises admission and kill/reap independently
		// of decoder speed. Production dispatch always calls RunWorker.
		if strings.HasSuffix(os.Args[2], "-blocked.png") {
			if err := os.WriteFile(os.Args[2]+".started", []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
				os.Exit(2)
			}
			time.Sleep(time.Hour)
			os.Exit(2)
		}
		os.Exit(attachmentimage.RunWorker(os.Args[2], os.Args[3], os.Stdout))
	}
	os.Exit(m.Run())
}

func TestStillPNGOptimizedWithAlpha(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	output := filepath.Join(dir, "output")
	img := image.NewNRGBA(image.Rect(0, 0, 64, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 64; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: 255, A: uint8(x * 4)})
		}
	}
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	if err = png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := attachmentimage.NewProcessor().Process(context.Background(), source, output)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Optimized || !result.Inline || result.ContentType != "image/webp" || result.Width != 64 || result.Height != 32 {
		t.Fatalf("result: %+v", result)
	}
	encoded, err := os.Open(output)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = encoded.Close() }()
	decoded, err := webp.Decode(encoded)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, a := decoded.At(0, 0).RGBA()
	if a != 0 {
		t.Fatalf("alpha lost: %d", a)
	}
	_, _, _, a = decoded.At(32, 0).RGBA()
	if a < 30000 || a > 35000 {
		t.Fatalf("intermediate alpha lost: %d", a)
	}
}

func TestExistingOutputSurvivesFailure(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	output := filepath.Join(dir, "output")
	if err := os.WriteFile(source, []byte("\x89PNGbad"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	var response bytes.Buffer
	attachmentimage.RunWorker(source, output, &response)
	data, err := os.ReadFile(output)
	if err != nil || string(data) != "keep" {
		t.Fatalf("existing output removed: %v", err)
	}
}
