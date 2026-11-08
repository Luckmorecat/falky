package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/attachments"
	attachmentimage "github.com/kisshot/falky/server/internal/attachments/image"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/rooms"
)

const (
	multipartOverhead = 16 << 10
	multipartHeaders  = 8 << 10
	maxContentStreams = 8
	contentTimeout    = 120 * time.Second
)

var (
	contentStreams    = make(chan struct{}, maxContentStreams)
	uploadRequests    = make(chan struct{}, attachments.MaxUploadStreams)
	errMultipartLimit = errors.New("multipart envelope exceeds limit")
)

type attachmentHandlers struct {
	store    *attachments.Store
	rooms    *rooms.Service
	resolve  visitorResolver
	origin   string
	errs     errorWriter
	shutdown context.Context
}

func attachmentRoute(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		handler(w, r)
	}
}

func (a attachmentHandlers) sameOrigin(w http.ResponseWriter, r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" && !strings.EqualFold(origin, a.origin) {
		writeError(w, http.StatusForbidden, "origin_forbidden", "attachment changes require this server's origin")
		return false
	}
	return true
}

func (a attachmentHandlers) authorize(w http.ResponseWriter, r *http.Request, v identity.Visitor, roomID string, action rooms.Action) bool {
	err := a.rooms.Authorize(r.Context(), v, roomID, action)
	if errors.Is(err, rooms.ErrNotFound) {
		writeError(w, http.StatusNotFound, "room_not_found", "no such room")
		return false
	}
	if err != nil {
		a.errs.internal(w, r, err)
		return false
	}
	return true
}

func (a attachmentHandlers) available(w http.ResponseWriter) bool {
	if a.store == nil {
		writeError(w, 503, "attachment_unavailable", "attachments are unavailable")
		return false
	}
	return true
}

func (a attachmentHandlers) upload(w http.ResponseWriter, r *http.Request) {
	v, ok := a.resolve.visitor(w, r)
	if !ok || !a.sameOrigin(w, r) || !a.authorize(w, r, v, r.PathValue("id"), rooms.PostMessage) || !a.available(w) {
		return
	}
	select {
	case uploadRequests <- struct{}{}:
		defer func() { <-uploadRequests }()
	default:
		writeError(w, http.StatusTooManyRequests, "attachment_busy", "too many active uploads")
		return
	}
	limits := a.store.Limits()
	ctx, cancel := context.WithTimeout(r.Context(), limits.UploadTimeout)
	defer cancel()
	r = r.WithContext(ctx)
	rc := http.NewResponseController(w)
	if err := rc.SetReadDeadline(time.Now().Add(limits.UploadTimeout)); err != nil {
		a.errs.internal(w, r, err)
		return
	}
	defer func() { _ = rc.SetReadDeadline(time.Time{}) }()
	if a.shutdown != nil {
		stopped := make(chan struct{})
		stop := context.AfterFunc(a.shutdown, func() { _ = rc.SetReadDeadline(time.Now()); close(stopped) })
		defer func() {
			if !stop() {
				<-stopped
			}
		}()
	}
	r.Body = http.MaxBytesReader(w, r.Body, limits.MaxFileBytes+multipartOverhead)
	defer func() { _ = r.Body.Close() }()
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "multipart/form-data" || len(params["boundary"]) == 0 || len(params["boundary"]) > 70 {
		writeError(w, 400, "invalid_request", "expected one multipart file")
		return
	}
	// NextPart parses headers before returning. Bound those reads separately
	// from file bytes, then retain an overhead allowance as the file streams.
	envelope := &envelopeReader{source: r.Body, allowance: multipartHeaders}
	mr := multipart.NewReader(envelope, params["boundary"])
	part, err := mr.NextRawPart()
	if err != nil {
		a.multipartError(w, r, err)
		return
	}
	_, disposition, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
	if err != nil || part.FormName() != "file" || disposition["filename"] == "" || len(disposition["filename"]) > 255 || len(part.Header) > 8 || part.Header.Get("Content-Transfer-Encoding") != "" {
		writeError(w, 400, "invalid_request", "expected exactly one file with bounded headers and filename")
		return
	}
	for _, values := range part.Header {
		if len(values) != 1 {
			writeError(w, 400, "invalid_request", "duplicate multipart header")
			return
		}
	}
	envelope.allowance = multipartOverhead
	file := &filePartReader{source: part, envelope: envelope}
	m, err := a.store.Upload(ctx, v.ID, r.PathValue("id"), disposition["filename"], file)
	if err != nil {
		if errors.Is(err, errMultipartLimit) {
			a.multipartError(w, r, err)
		} else {
			a.failure(w, r, err)
		}
		return
	}
	// A draft is not acknowledged until the complete envelope is valid.
	// Cleanup uses an independent bounded context when a read timed out.
	valid := false
	defer func() {
		if !valid {
			cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer stop()
			if err := a.store.Cancel(cleanup, v.ID, m.ID); err != nil {
				a.errs.logger.Error("cancel rejected multipart draft", "error", err)
			}
		}
	}()
	if _, err = mr.NextRawPart(); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("extra part")
		}
		a.multipartError(w, r, err)
		return
	}
	if _, err = io.Copy(io.Discard, envelope); err != nil {
		a.multipartError(w, r, err)
		return
	}
	valid = true
	writeAttachmentJSON(w, http.StatusCreated, attachmentBody(m))
}

// envelopeReader bounds header parsing and multipart overhead independently
// of file length, including read-ahead and the otherwise ignored epilogue.
type envelopeReader struct {
	source                      io.Reader
	total, fileBytes, allowance int64
}

func (r *envelopeReader) Read(p []byte) (int, error) {
	remaining := r.fileBytes + r.allowance - r.total
	if remaining <= 0 {
		var probe [1]byte
		n, err := r.source.Read(probe[:])
		if n == 0 && errors.Is(err, io.EOF) {
			return 0, io.EOF
		}
		return 0, errMultipartLimit
	}
	if int64(len(p)) > remaining {
		p = p[:remaining]
	}
	n, err := r.source.Read(p)
	r.total += int64(n)
	return n, err
}

type filePartReader struct {
	source   io.Reader
	envelope *envelopeReader
}

func (r *filePartReader) Read(p []byte) (int, error) {
	n, err := r.source.Read(p)
	r.envelope.fileBytes += int64(n)
	return n, err
}

func (a attachmentHandlers) multipartError(w http.ResponseWriter, r *http.Request, err error) {
	var maxBytes *http.MaxBytesError
	var timeout net.Error
	switch {
	case errors.Is(err, errMultipartLimit), errors.As(err, &maxBytes):
		writeError(w, 413, "attachment_too_large", "file or multipart envelope exceeds its limit")
	case errors.As(err, &timeout) && timeout.Timeout(), errors.Is(err, context.DeadlineExceeded):
		writeError(w, 408, "upload_timeout", "upload deadline elapsed")
	default:
		writeError(w, 400, "invalid_request", "expected exactly one complete multipart file")
	}
}

func (a attachmentHandlers) record(w http.ResponseWriter, r *http.Request) (identity.Visitor, attachments.Record, bool) {
	v, ok := a.resolve.visitor(w, r)
	if !ok || !a.available(w) {
		return v, attachments.Record{}, false
	}
	m, err := a.store.Visible(r.Context(), v.ID, r.PathValue("id"))
	if err != nil {
		a.failure(w, r, err)
		return v, m, false
	}
	return v, m, a.authorize(w, r, v, m.RoomID, rooms.ReadMessages)
}

func (a attachmentHandlers) status(w http.ResponseWriter, r *http.Request) {
	_, m, ok := a.record(w, r)
	if !ok {
		return
	}
	writeAttachmentJSON(w, 200, attachmentBody(m.Metadata))
}

func (a attachmentHandlers) cancel(w http.ResponseWriter, r *http.Request) {
	v, ok := a.resolve.visitor(w, r)
	if !ok || !a.sameOrigin(w, r) || !a.available(w) {
		return
	}
	m, err := a.store.Visible(r.Context(), v.ID, r.PathValue("id"))
	if err != nil {
		a.failure(w, r, err)
		return
	}
	if !a.authorize(w, r, v, m.RoomID, rooms.PostMessage) {
		return
	}
	if err := a.store.Cancel(r.Context(), v.ID, m.ID); err != nil {
		a.failure(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (a attachmentHandlers) content(w http.ResponseWriter, r *http.Request) {
	v, m, ok := a.record(w, r)
	if !ok {
		return
	}
	select {
	case contentStreams <- struct{}{}:
		defer func() { <-contentStreams }()
	default:
		writeError(w, 429, "attachment_busy", "too many content streams")
		return
	}
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Now().Add(contentTimeout)); err != nil {
		a.errs.internal(w, r, err)
		return
	}
	defer func() { _ = rc.SetWriteDeadline(time.Time{}) }()
	c, err := a.store.Open(r.Context(), v.ID, m.ID)
	if err != nil {
		a.failure(w, r, err)
		return
	}
	defer func() { _ = c.File.Close() }()
	disposition := "attachment"
	if c.Inline {
		disposition = "inline"
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", c.ContentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": c.Filename}))
	w.Header().Set("Content-Length", strconv.FormatInt(c.Size, 10))
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, c.File); err != nil {
		a.errs.logger.DebugContext(r.Context(), "attachment content interrupted", "error", err)
	}
}

func (a attachmentHandlers) limits(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.resolve.visitor(w, r); !ok || !a.available(w) {
		return
	}
	l := a.store.Limits()
	writeAttachmentJSON(w, 200, api.AttachmentLimits{
		MaxFileBytes: l.MaxFileBytes, MaxOutputBytes: l.MaxOutputBytes, StagingBytes: l.StagingBytes, PostedBytes: l.PostedBytes,
		MaxAttachments: int64(l.MaxAttachments), MaxPending: int64(l.MaxPending), MaxUploadStreams: int64(l.MaxUploadStreams), MaxPixels: int64(l.MaxPixels), MaxEdge: int64(l.MaxEdge), MaxDimension: int64(l.MaxDimension),
		DraftTtlSeconds: int64(l.DraftTTL / time.Second), ProcessTimeoutSeconds: int64(l.ProcessTimeout / time.Second), UploadTimeoutSeconds: int64(l.UploadTimeout / time.Second), UploadBurst: int64(l.UploadBurst), UploadRefillSeconds: int64(l.UploadRefill / time.Second),
		MultipartOverheadBytes: multipartOverhead, MultipartHeaderBytes: multipartHeaders, MaxContentStreams: maxContentStreams, ContentTimeoutSeconds: int64(contentTimeout / time.Second), MaxConversions: 1,
	})
}

func writeAttachmentJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (a attachmentHandlers) failure(w http.ResponseWriter, r *http.Request, err error) {
	status, body, ok := attachmentError(err)
	if !ok {
		a.errs.internal(w, r, err)
		return
	}
	writeError(w, status, body.Code, body.Message)
}

func attachmentError(err error) (int, api.Error, bool) {
	status, code, message := 0, "", ""
	var maxBytes *http.MaxBytesError
	var timeout net.Error
	switch {
	case errors.Is(err, attachments.ErrNotFound):
		status, code, message = 404, "attachment_not_found", "no such attachment"
	case errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, multipart.ErrMessageTooLarge):
		status, code, message = 400, "invalid_request", "expected exactly one complete multipart file"
	case errors.Is(err, attachments.ErrExpired):
		status, code, message = 410, "attachment_expired", "attachment is unavailable"
	case errors.Is(err, attachments.ErrInvalidAttachments):
		status, code, message = 400, "invalid_attachments", "choose up to four distinct ready drafts owned by this visitor in this room"
	case errors.Is(err, attachments.ErrTooLarge), errors.Is(err, attachmentimage.ErrInputTooLarge), errors.As(err, &maxBytes):
		status, code, message = 413, "attachment_too_large", "file exceeds 25 MiB"
	case errors.Is(err, attachmentimage.ErrInvalidImage):
		status, code, message = 400, "invalid_image", "supported image is malformed"
	case errors.Is(err, attachmentimage.ErrDimensions):
		status, code, message = 400, "image_dimensions", "image dimensions exceed supported limits"
	case errors.Is(err, attachments.ErrBusy):
		status, code, message = 429, "attachment_busy", "too many pending uploads or active streams"
	case errors.Is(err, attachments.ErrRateLimited):
		status, code, message = 429, "rate_limited", "too many uploads; try again later"
	case errors.Is(err, attachments.ErrStagingFull), errors.Is(err, attachments.ErrQuota), errors.Is(err, attachments.ErrCleanupPending):
		status, code, message = 503, "attachment_capacity", "attachment capacity is unavailable; try again later"
	case errors.Is(err, attachments.ErrClosed), errors.Is(err, context.Canceled):
		status, code, message = 503, "attachment_unavailable", "attachments are unavailable"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &timeout) && timeout.Timeout():
		status, code, message = 408, "upload_timeout", "upload deadline elapsed"
	case errors.Is(err, attachmentimage.ErrProcessing), errors.Is(err, attachmentimage.ErrOutputTooLarge):
		status, code, message = 503, "attachment_processing", "image processing is unavailable"
	default:
		return 0, api.Error{}, false
	}
	return status, api.Error{Code: code, Message: message}, true
}

func attachmentBody(m attachments.Metadata) api.Attachment {
	out := api.Attachment{Id: m.ID, Filename: m.Filename, ContentType: m.ContentType, Size: m.Size, Inline: m.Inline, Width: m.Width, Height: m.Height, Availability: api.AttachmentAvailability(m.Availability), ContentUrl: "/api/attachments/" + m.ID + "/content"}
	if !m.ExpiresAt.IsZero() {
		out.ExpiresAt = &m.ExpiresAt
	}
	return out
}
