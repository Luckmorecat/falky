package image

import (
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"os"

	encoder "github.com/gen2brain/vpx/webp"
	"golang.org/x/image/draw"
	decoder "golang.org/x/image/webp"
)

func convert(sourcePath, outputPath string) (Result, error) {
	f, err := os.Open(sourcePath)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = f.Close() }()
	kind, _, err := classify(f)
	if err != nil {
		return Result{}, err
	}
	if kind == "" {
		return Result{}, ErrInvalidImage
	}
	var config image.Config
	switch kind {
	case "jpeg":
		config, err = jpeg.DecodeConfig(f)
	case "png":
		config, err = png.DecodeConfig(f)
	case "webp":
		config, err = decoder.DecodeConfig(f)
	}
	if err != nil {
		return Result{}, ErrInvalidImage
	}
	w, h := config.Width, config.Height
	if err := checkDimensions(w, h); err != nil {
		return Result{}, err
	}
	if kind == "webp" {
		if err := validateWebPFrames(f, w, h); err != nil {
			return Result{}, err
		}
	}
	orientation := readOrientation(f, kind)
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return Result{}, err
	}
	var decoded image.Image
	switch kind {
	case "jpeg":
		decoded, err = jpeg.Decode(f)
	case "png":
		decoded, err = png.Decode(f)
	case "webp":
		decoded, err = decoder.Decode(f)
	}
	if err != nil {
		return Result{}, ErrInvalidImage
	}
	if decoded.Bounds().Dx() != w || decoded.Bounds().Dy() != h {
		return Result{}, ErrInvalidImage
	}
	oriented := orientedImage{Image: decoded, orientation: orientation}
	w, h = oriented.Bounds().Dx(), oriented.Bounds().Dy()
	if w > MaxDimension || h > MaxDimension {
		if w >= h {
			h = max(1, h*MaxDimension/w)
			w = MaxDimension
		} else {
			w = max(1, w*MaxDimension/h)
			h = MaxDimension
		}
	}
	// A lazy orientation view lets scaling read the original 16-bit pixels without
	// allocating a full-size rotated copy or a second full-size 8-bit image.
	normalized := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.ApproxBiLinear.Scale(normalized, normalized.Bounds(), oriented, oriented.Bounds(), draw.Src, nil)
	output, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Result{}, err
	}
	complete := false
	defer func() {
		if !complete {
			_ = output.Close()
			_ = os.Remove(outputPath)
		}
	}()
	writer := limitedWriter{writer: output, remaining: MaxOutputBytes}
	err = encoder.Encode(&writer, normalized, encoder.EncodeOptions{Quality: 80, Method: 0, Threads: 1})
	closeErr := output.Close()
	if err != nil {
		return Result{}, err
	}
	if closeErr != nil {
		return Result{}, closeErr
	}
	complete = true
	return Result{Optimized: true, Inline: true, ContentType: "image/webp", Size: MaxOutputBytes - writer.remaining, Width: w, Height: h}, nil
}

type limitedWriter struct {
	writer    io.Writer
	remaining int64
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, ErrOutputTooLarge
	}
	n, err := w.writer.Write(p)
	w.remaining -= int64(n)
	return n, err
}

type orientedImage struct {
	image.Image
	orientation int
}

func (o orientedImage) Bounds() image.Rectangle {
	b := o.Image.Bounds()
	w, h := b.Dx(), b.Dy()
	if o.orientation >= 5 {
		w, h = h, w
	}
	return image.Rect(0, 0, w, h)
}

func (o orientedImage) At(x, y int) color.Color {
	b := o.Image.Bounds()
	w, h := b.Dx(), b.Dy()
	switch o.orientation {
	case 2:
		x = w - 1 - x
	case 3:
		x, y = w-1-x, h-1-y
	case 4:
		y = h - 1 - y
	case 5:
		x, y = y, x
	case 6:
		x, y = y, h-1-x
	case 7:
		x, y = w-1-y, h-1-x
	case 8:
		x, y = w-1-y, x
	}
	return o.Image.At(x+b.Min.X, y+b.Min.Y)
}

// x/image's RGBA64 destination path requires an RGBA64Image source. Providing
// this method also keeps scaling lazy for oriented 16-bit PNGs.
func (o orientedImage) RGBA64At(x, y int) color.RGBA64 {
	return color.RGBA64Model.Convert(o.At(x, y)).(color.RGBA64)
}

func checkDimensions(w, h int) error {
	if w < 1 || h < 1 || w > MaxEdge || h > MaxEdge || int64(w)*int64(h) > MaxPixels {
		return ErrDimensions
	}
	return nil
}
