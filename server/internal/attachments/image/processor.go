// Package image classifies staged files and optimizes supported still images.
// Paths belong to the attachment store and must never come from request filenames.
package image

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	MaxInputBytes  int64 = 25 * 1024 * 1024
	MaxOutputBytes int64 = 32 * 1024 * 1024
	MaxPixels            = 24_000_000
	MaxEdge              = 16_384
	MaxDimension         = 2560
	ProcessTimeout       = 30 * time.Second
	WorkerCommand        = "__image-process"
)

var (
	ErrInvalidImage   = errors.New("invalid image")
	ErrDimensions     = errors.New("image dimensions exceed limits")
	ErrInputTooLarge  = errors.New("input exceeds limit")
	ErrOutputTooLarge = errors.New("processed output exceeds limit")
	ErrProcessing     = errors.New("image processing failed")
	// All processors share one slot; it is released only after Wait reaps the child.
	conversionSlot = make(chan struct{}, 1)
)

type Result struct {
	Optimized   bool   `json:"optimized"`
	Inline      bool   `json:"inline"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
}

type Processor struct{}

func NewProcessor() *Processor { return &Processor{} }

// Process retains sourcePath. Preserved files produce no output; optimized files
// produce a closed 0600 outputPath, which must be a unique nonexistent path.
// The caller adopts or deletes both files. Errors remove partial output.
func (*Processor) Process(ctx context.Context, sourcePath, outputPath string) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	source, err := filepath.Abs(sourcePath)
	if err != nil {
		return Result{}, err
	}
	output, err := filepath.Abs(outputPath)
	if err != nil {
		return Result{}, err
	}
	if source == output {
		return Result{}, ErrProcessing
	}
	if _, err := os.Lstat(output); !os.IsNotExist(err) {
		return Result{}, ErrProcessing
	}
	f, err := os.Open(source)
	if err != nil {
		return Result{}, err
	}
	kind, result, err := classify(f)
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return Result{}, errors.Join(err, closeErr)
	}
	if kind == "" {
		return result, nil
	}
	select {
	case conversionSlot <- struct{}{}:
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
	defer func() { <-conversionSlot }()
	childCtx, cancel := context.WithTimeout(ctx, ProcessTimeout)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		return Result{}, err
	}
	cmd := exec.CommandContext(childCtx, executable, WorkerCommand, source, output)
	// GOMEMLIMIT is a soft GC target, not an RSS ceiling. No caller value may override it.
	cmd.Env = append(withoutEnv(os.Environ(), "GOMEMLIMIT"), "GOMEMLIMIT=256MiB")
	var stdout, stderr boundedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err = cmd.Run(); err != nil {
		_ = os.Remove(output)
		if childCtx.Err() != nil {
			return Result{}, childCtx.Err()
		}
		return Result{}, ErrProcessing
	}
	var response workerResponse
	if stdout.overflow || json.Unmarshal(stdout.Bytes(), &response) != nil {
		_ = os.Remove(output)
		return Result{}, ErrProcessing
	}
	if response.Error != "" {
		_ = os.Remove(output)
		return Result{}, decodeError(response.Error)
	}
	info, err := os.Stat(output)
	if err != nil || info.Size() != response.Result.Size || info.Size() > MaxOutputBytes || !response.Result.Optimized || !response.Result.Inline || response.Result.ContentType != "image/webp" || response.Result.Width < 1 || response.Result.Height < 1 || response.Result.Width > MaxDimension || response.Result.Height > MaxDimension {
		_ = os.Remove(output)
		return Result{}, ErrProcessing
	}
	return response.Result, nil
}

func withoutEnv(env []string, key string) []string {
	result := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, key+"=") {
			result = append(result, entry)
		}
	}
	return result
}

type boundedBuffer struct {
	bytes.Buffer
	overflow bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := 4096 - b.Len()
	if n > remaining {
		p = p[:remaining]
		b.overflow = true
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}

type workerResponse struct {
	Result Result `json:"result"`
	Error  string `json:"error,omitempty"`
}

// RunWorker is the private same-executable protocol, dispatched before server
// configuration. Only the subprocess calls it; server requests use Process.
func RunWorker(sourcePath, outputPath string, stdout io.Writer) int {
	watchdog := time.AfterFunc(ProcessTimeout, func() { os.Exit(1) })
	defer watchdog.Stop()
	result, err := convert(sourcePath, outputPath)
	response := workerResponse{Result: result}
	if err != nil {
		response.Error = encodeError(err)
	}
	if json.NewEncoder(stdout).Encode(response) != nil {
		return 1
	}
	return 0
}

func encodeError(err error) string {
	switch {
	case errors.Is(err, ErrInvalidImage):
		return "invalid"
	case errors.Is(err, ErrDimensions):
		return "dimensions"
	case errors.Is(err, ErrInputTooLarge):
		return "input"
	case errors.Is(err, ErrOutputTooLarge):
		return "output"
	default:
		return "processing"
	}
}

func decodeError(code string) error {
	switch code {
	case "invalid":
		return ErrInvalidImage
	case "dimensions":
		return ErrDimensions
	case "input":
		return ErrInputTooLarge
	case "output":
		return ErrOutputTooLarge
	default:
		return ErrProcessing
	}
}

func classify(f *os.File) (string, Result, error) {
	stat, err := f.Stat()
	if err != nil {
		return "", Result{}, err
	}
	if !stat.Mode().IsRegular() {
		return "", Result{}, ErrProcessing
	}
	if stat.Size() > MaxInputBytes {
		return "", Result{}, ErrInputTooLarge
	}
	var header [512]byte
	n, err := f.ReadAt(header[:], 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", Result{}, err
	}
	data := header[:n]
	result := Result{Size: stat.Size(), ContentType: http.DetectContentType(data)}
	switch {
	case bytes.HasPrefix(data, []byte{0xff, 0xd8}):
		return "jpeg", result, nil
	case bytes.HasPrefix(data, []byte{0x89, 'P', 'N', 'G'}):
		animated, err := pngAnimated(f, stat.Size())
		if err != nil {
			return "", Result{}, err
		}
		if animated {
			result.ContentType = "image/png"
			return "", result, nil
		}
		return "png", result, nil
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		animated, _, err := webpMetadata(f, stat.Size())
		if err != nil {
			return "", Result{}, err
		}
		if animated {
			result.ContentType = "image/webp"
			return "", result, nil
		}
		return "webp", result, nil
	default:
		return "", result, nil
	}
}
