package image_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	encoder "github.com/gen2brain/vpx/webp"
	attachmentimage "github.com/kisshot/falky/server/internal/attachments/image"
	"golang.org/x/image/webp"
)

func TestAllOrientations(t *testing.T) {
	colors := []color.NRGBA{{R: 255, A: 255}, {G: 255, A: 255}, {B: 255, A: 255}, {R: 255, G: 255, B: 255, A: 255}}
	// Expected input-corner indexes at output TL, TR, BL, BR, from EXIF's
	// published mirror/rotation definitions (the source is 64 by 32).
	expected := [][4]int{{0, 1, 2, 3}, {1, 0, 3, 2}, {3, 2, 1, 0}, {2, 3, 0, 1}, {0, 2, 1, 3}, {2, 0, 3, 1}, {3, 1, 2, 0}, {1, 3, 0, 2}}
	src := image.NewNRGBA(image.Rect(0, 0, 64, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 64; x++ {
			src.SetNRGBA(x, y, colors[y/16*2+x/32])
		}
	}
	for _, format := range []string{"jpeg", "png", "webp"} {
		for orientation := 1; orientation <= 8; orientation++ {
			t.Run(format+"/"+string(rune('0'+orientation)), func(t *testing.T) {
				data := orientedFixture(t, src, format, orientation)
				result, output := processFixture(t, data)
				w, h := 64, 32
				if orientation >= 5 {
					w, h = 32, 64
				}
				if result.Width != w || result.Height != h {
					t.Fatalf("dimensions: %+v", result)
				}
				if bytes.Contains(output, []byte("EXIF")) || bytes.Contains(output, []byte("ICCP")) || bytes.Contains(output, []byte("XMP ")) {
					t.Fatal("metadata retained")
				}
				decoded, err := webp.Decode(bytes.NewReader(output))
				if err != nil {
					t.Fatal(err)
				}
				for i, point := range []image.Point{{4, 4}, {w - 5, 4}, {4, h - 5}, {w - 5, h - 5}} {
					actual := color.NRGBAModel.Convert(decoded.At(point.X, point.Y)).(color.NRGBA)
					want := colors[expected[orientation-1][i]]
					if abs(int(actual.R)-int(want.R)) > 50 || abs(int(actual.G)-int(want.G)) > 50 || abs(int(actual.B)-int(want.B)) > 50 {
						t.Fatalf("corner %d: got %v want %v", i, actual, want)
					}
				}
			})
		}
	}
}

func TestResize16BitPNGWithoutUpscaling(t *testing.T) {
	src := image.NewNRGBA64(image.Rect(0, 0, 4000, 100))
	for y := 0; y < 100; y++ {
		for x := 0; x < 4000; x++ {
			src.SetNRGBA64(x, y, color.NRGBA64{R: 65535, A: uint16(x * 65535 / 3999)})
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, src); err != nil {
		t.Fatal(err)
	}

	result, output := processFixture(t, data.Bytes())
	if result.Width != 2560 || result.Height != 64 {
		t.Fatalf("dimensions: %+v", result)
	}
	decoded, err := webp.Decode(bytes.NewReader(output))
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, alpha := decoded.At(1280, 32).RGBA()
	if alpha < 31000 || alpha > 35000 {
		t.Fatalf("alpha: %d", alpha)
	}
}

func TestRejectsInvalidAndOversizedSupportedImages(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want error
	}{
		{"jpeg", []byte{255, 216, 255}, attachmentimage.ErrInvalidImage},
		{"png", []byte("\x89PNG\r\n\x1a\ntruncated"), attachmentimage.ErrInvalidImage},
		{"webp", []byte("RIFF\x20\x00\x00\x00WEBPVP8 "), attachmentimage.ErrInvalidImage},
		{"edge", pngHeader(16385, 1), attachmentimage.ErrDimensions},
		{"pixels", pngHeader(6000, 5000), attachmentimage.ErrDimensions},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			source := filepath.Join(dir, "source")
			output := filepath.Join(dir, "output")
			if err := os.WriteFile(source, tc.data, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := attachmentimage.NewProcessor().Process(context.Background(), source, output)
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v want %v", err, tc.want)
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatalf("output left after failure: %v", err)
			}
		})
	}
}

func TestAnimatedWebPRemainsUnchanged(t *testing.T) {
	// Animation is classified by both the extended-header flag and ANIM/ANMF;
	// it must never enter the still decoder, even with corrupt animation frames.
	for _, body := range [][]byte{
		append([]byte("VP8X\x0a\x00\x00\x00"), []byte{2, 0, 0, 0, 63, 0, 0, 31, 0, 0}...),
		[]byte("ANIM\x06\x00\x00\x00\x00\x00\x00\x00\x00\x00"),
	} {
		data := append([]byte("RIFF\x00\x00\x00\x00WEBP"), body...)
		binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
		dir := t.TempDir()
		source := filepath.Join(dir, "source")
		output := filepath.Join(dir, "output")
		if err := os.WriteFile(source, data, 0o600); err != nil {
			t.Fatal(err)
		}
		result, err := attachmentimage.NewProcessor().Process(context.Background(), source, output)
		if err != nil {
			t.Fatal(err)
		}
		if result.Optimized || result.Inline || result.ContentType != "image/webp" {
			t.Fatalf("result: %+v", result)
		}
		actual, err := os.ReadFile(source)
		if err != nil || !bytes.Equal(actual, data) {
			t.Fatal("animation changed")
		}
		if _, err := os.Stat(output); !os.IsNotExist(err) {
			t.Fatalf("output: %v", err)
		}
	}
}

func TestCancellationReapsWorkerAndAllowsNextConversion(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 3000, 2000))
	var data bytes.Buffer
	if err := png.Encode(&data, src); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	output := filepath.Join(dir, "output")
	if err := os.WriteFile(source, data.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := attachmentimage.NewProcessor().Process(ctx, source, output)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancellation: %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("child was not promptly killed and reaped")
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatalf("partial output remains: %v", err)
	}
	// A new instance shares admission and must make progress after cancellation.
	small := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	var next bytes.Buffer
	if err := png.Encode(&next, small); err != nil {
		t.Fatal(err)
	}
	processFixture(t, next.Bytes())
}

func processFixture(t *testing.T, data []byte) (attachmentimage.Result, []byte) {
	t.Helper()
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	output := filepath.Join(dir, "output")
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := attachmentimage.NewProcessor().Process(context.Background(), source, output)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if result.Size != int64(len(encoded)) {
		t.Fatalf("stored size: %+v", result)
	}
	stat, err := os.Stat(output)
	if err != nil || stat.Mode().Perm() != 0o600 {
		t.Fatalf("private output: %v %v", stat, err)
	}
	return result, encoded
}

func orientedFixture(t *testing.T, src image.Image, format string, orientation int) []byte {
	t.Helper()
	var buffer bytes.Buffer
	tiff := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, byte(orientation), 0, 0, 0, 0, 0, 0, 0}
	switch format {
	case "jpeg":
		if err := jpeg.Encode(&buffer, src, &jpeg.Options{Quality: 100}); err != nil {
			t.Fatal(err)
		}
		data := buffer.Bytes()
		segment := []byte{255, 225, 0, 34}
		segment = append(segment, []byte("Exif\x00\x00")...)
		segment = append(segment, tiff...)
		return append(append(append([]byte{}, data[:2]...), segment...), data[2:]...)
	case "png":
		if err := png.Encode(&buffer, src); err != nil {
			t.Fatal(err)
		}
		data := buffer.Bytes()
		return append(append(append([]byte{}, data[:33]...), pngChunk("eXIf", tiff)...), data[33:]...)
	case "webp":
		if err := encoder.Encode(&buffer, src, encoder.EncodeOptions{Lossless: true, Method: 0, Threads: 1}); err != nil {
			t.Fatal(err)
		}
		data := append([]byte("RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x08\x00\x00\x00\x3f\x00\x00\x1f\x00\x00"), buffer.Bytes()[12:]...)
		data = append(data, []byte("EXIF\x1a\x00\x00\x00")...)
		data = append(data, tiff...)
		binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
		return data
	}
	t.Fatal("unknown fixture format")
	return nil
}

func pngChunk(kind string, body []byte) []byte {
	result := make([]byte, len(body)+12)
	binary.BigEndian.PutUint32(result[:4], uint32(len(body)))
	copy(result[4:8], kind)
	copy(result[8:], body)
	binary.BigEndian.PutUint32(result[len(result)-4:], crc32.ChecksumIEEE(result[4:len(result)-4]))
	return result
}

func pngHeader(w, h uint32) []byte {
	body := make([]byte, 13)
	binary.BigEndian.PutUint32(body[:4], w)
	binary.BigEndian.PutUint32(body[4:8], h)
	body[8] = 8
	body[9] = 6
	return append([]byte("\x89PNG\r\n\x1a\n"), pngChunk("IHDR", body)...)
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func TestWebPCanvasCannotHideOversizedFrame(t *testing.T) {
	// A tiny extended canvas must not authorize a 30MP VP8L allocation.
	frame := uint32(5999) | uint32(4999)<<14
	data := []byte("RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00\x3f\x00\x00\x1f\x00\x00VP8L\x05\x00\x00\x00\x2f\x00\x00\x00\x00\x00")
	binary.LittleEndian.PutUint32(data[len(data)-5:len(data)-1], frame)
	binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	output := filepath.Join(dir, "output")
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := attachmentimage.NewProcessor().Process(context.Background(), source, output)
	if !errors.Is(err, attachmentimage.ErrDimensions) {
		t.Fatalf("got %v want dimension rejection before full decoding", err)
	}
}

func TestAllProcessorsShareAdmissionUntilChildIsReaped(t *testing.T) {
	dir := t.TempDir()
	var fixture bytes.Buffer
	if err := png.Encode(&fixture, image.NewNRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	first := filepath.Join(dir, "first-blocked.png")
	second := filepath.Join(dir, "second-blocked.png")
	for _, path := range []string{first, second} {
		if err := os.WriteFile(path, fixture.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := attachmentimage.NewProcessor().Process(ctx, first, filepath.Join(dir, "first-output"))
		done <- err
	}()
	var pidData []byte
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(first + ".started")
		if err == nil && len(data) > 0 {
			pidData = data
			break
		}
		time.Sleep(time.Millisecond)
	}
	if len(pidData) == 0 {
		t.Fatal("first worker did not start")
	}
	pid, err := strconv.Atoi(string(pidData))
	if err != nil {
		t.Fatal(err)
	}
	waiting, stopWaiting := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer stopWaiting()
	_, err = attachmentimage.NewProcessor().Process(waiting, second, filepath.Join(dir, "second-output"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("queued cancellation: %v", err)
	}
	if _, err := os.Stat(second + ".started"); !os.IsNotExist(err) {
		t.Fatalf("second worker overlapped first: %v", err)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("running cancellation: %v", err)
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("worker still alive or unreaped after Process returned: %v", err)
	}
	processFixture(t, fixture.Bytes())
}

func TestProcessorEnforcesInputByteLimitWithoutBuffering(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	output := filepath.Join(dir, "output")
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(attachmentimage.MaxInputBytes); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	result, err := attachmentimage.NewProcessor().Process(context.Background(), source, output)
	if err != nil || result.Optimized || result.Size != attachmentimage.MaxInputBytes {
		t.Fatalf("exact-limit general file: %+v, %v", result, err)
	}
	if err := os.Truncate(source, attachmentimage.MaxInputBytes+1); err != nil {
		t.Fatal(err)
	}
	_, err = attachmentimage.NewProcessor().Process(context.Background(), source, output)
	if !errors.Is(err, attachmentimage.ErrInputTooLarge) {
		t.Fatalf("oversize input: %v", err)
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatalf("oversize output: %v", err)
	}
}

func TestAPNGRemainsUnchangedAndDownloadOnly(t *testing.T) {
	// Pillow-generated 8x8 APNG: two independently verified red/blue frames.
	data, err := os.ReadFile("testdata/animated.png")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	output := filepath.Join(dir, "output")
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := attachmentimage.NewProcessor().Process(context.Background(), source, output)
	if err != nil {
		t.Fatal(err)
	}
	if result.Optimized || result.Inline || result.ContentType != "image/png" || result.Size != int64(len(data)) || result.Width != 0 || result.Height != 0 {
		t.Fatalf("animation must remain a download: %+v", result)
	}
	original, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(original, data) {
		t.Fatalf("animation changed: %v", err)
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatalf("animation produced an output: %v", err)
	}
}

func TestPrivateWorkerDoesNotFlattenAPNG(t *testing.T) {
	data, err := os.ReadFile("testdata/animated.png")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	output := filepath.Join(dir, "output")
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	var response bytes.Buffer
	if code := attachmentimage.RunWorker(source, output, &response); code != 0 {
		t.Fatalf("worker exit: %d", code)
	}
	var decoded struct{ Error string }
	if err := json.Unmarshal(response.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Error != "invalid" {
		t.Fatalf("worker must reject unsupported animation: %s", &response)
	}
	original, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(original, data) {
		t.Fatalf("worker changed source: %v", err)
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatalf("worker flattened animation: %v", err)
	}
}

func TestPNGAnimationChunkLengthsAreBounded(t *testing.T) {
	cases := [][]byte{
		append(pngHeader(8, 8), []byte{255, 255, 255, 255, 'a', 'c', 'T', 'L', 0, 0, 0, 0}...),
		append(pngHeader(8, 8), pngChunk("acTL", make([]byte, 7))...),
		append(pngHeader(8, 8), []byte{0, 0, 0, 8, 'a', 'c', 'T'}...),
	}
	for _, data := range cases {
		dir := t.TempDir()
		source := filepath.Join(dir, "source")
		output := filepath.Join(dir, "output")
		if err := os.WriteFile(source, data, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := attachmentimage.NewProcessor().Process(context.Background(), source, output)
		if !errors.Is(err, attachmentimage.ErrInvalidImage) {
			t.Fatalf("malformed PNG chunk: %v", err)
		}
		if _, err := os.Stat(output); !os.IsNotExist(err) {
			t.Fatalf("malformed PNG output: %v", err)
		}
	}
}

func TestStaticPNGMetadataDoesNotImplyAnimation(t *testing.T) {
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	original := encoded.Bytes()
	data := append(append(append([]byte{}, original[:33]...), pngChunk("tEXt", []byte("Comment\x00acTL fcTL fdAT"))...), original[33:]...)
	result, _ := processFixture(t, data)
	if !result.Optimized || !result.Inline || result.ContentType != "image/webp" {
		t.Fatalf("static PNG no longer optimized: %+v", result)
	}
}
