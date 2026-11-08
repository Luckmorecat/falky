package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/attachments"
	"github.com/kisshot/falky/server/internal/platform"
)

type unreadBody struct{ reads int }

func (b *unreadBody) Read([]byte) (int, error) { b.reads++; return 0, io.EOF }
func (*unreadBody) Close() error               { return nil }

func TestUploadAuthorizesBeforeReadingMultipart(t *testing.T) {
	p := startPublic(t, 10)
	r := p.createRoom(t, "Lounge")
	_, token, err := p.identity.Enter(t.Context(), p.secret, "Bob")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, room, origin, token string
		status                    int
	}{
		{"no visitor", r.ID, testOrigin, "", 401},
		{"foreign origin", r.ID, "https://evil.example", token, 403},
		{"unknown room", "unknown", testOrigin, token, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := &unreadBody{}
			req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/rooms/"+tc.room+"/attachments", body)
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("Content-Type", "multipart/form-data; boundary=test")
			if tc.token != "" {
				req.AddCookie(&http.Cookie{Name: cookieName, Value: tc.token})
			}
			w := httptest.NewRecorder()
			p.srv.Config.Handler.ServeHTTP(w, req)
			if w.Code != tc.status || body.reads != 0 {
				t.Fatalf("status=%d reads=%d body=%s", w.Code, body.reads, w.Body)
			}
		})
	}
}

func TestAttachmentEndpointsNeedAVisitor(t *testing.T) {
	p := startPublic(t, 10)
	for _, path := range []string{"/api/attachments/limits", "/api/attachments/unknown", "/api/attachments/unknown/content"} {
		status, _, body := get(t, p.srv, path)
		wantError(t, path, status, body, 401, "visitor_required")
	}
	req := httptest.NewRequestWithContext(t.Context(), http.MethodDelete, "/api/attachments/unknown", strings.NewReader(""))
	w := httptest.NewRecorder()
	p.srv.Config.Handler.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatalf("cancel status=%d", w.Code)
	}
}

func attachmentRequest(t *testing.T, p publicServer, hc *http.Client, method, path, media string, body io.Reader, headers ...http.Header) (int, http.Header, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, p.srv.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if media != "" {
		req.Header.Set("Content-Type", media)
	}
	for _, extra := range headers {
		for name, values := range extra {
			for _, value := range values {
				req.Header.Add(name, value)
			}
		}
	}
	res, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, res.Header, data
}

func uploadRequest(t *testing.T, p publicServer, hc *http.Client, roomID, filename string, data []byte) (int, []byte) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	status, _, out := attachmentRequest(t, p, hc, "POST", "/api/rooms/"+roomID+"/attachments", mw.FormDataContentType(), &body)
	return status, out
}

func uploadDraft(t *testing.T, p publicServer, hc *http.Client, roomID, filename string, data []byte) api.Attachment {
	t.Helper()
	status, out := uploadRequest(t, p, hc, roomID, filename, data)
	if status != 201 {
		t.Fatalf("upload=%d %s", status, out)
	}
	var m api.Attachment
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestPrivateDraftBecomesPostedWithCommonMetadata(t *testing.T) {
	p := startPublic(t, 10)
	r := p.createRoom(t, "Lounge")
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	other, otherHTTP := p.browserWithHTTP(t)
	p.enter(t, other, "Alice")
	ws := p.connectLive(t, otherHTTP)
	data := []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")
	draft := uploadDraft(t, p, hc, r.ID, "../unsafe\".svg", data)
	if draft.Availability != api.AttachmentAvailabilityReady || draft.Inline || draft.Size != int64(len(data)) {
		t.Fatalf("draft=%+v", draft)
	}
	status, _, out := attachmentRequest(t, p, otherHTTP, "GET", "/api/attachments/"+draft.Id, "", nil)
	wantError(t, "foreign draft", status, out, 404, "attachment_not_found")
	status, _, out = attachmentRequest(t, p, otherHTTP, "GET", draft.ContentUrl, "", nil)
	wantError(t, "foreign content", status, out, 404, "attachment_not_found")
	res, err := b.PostMessageWithResponse(t.Context(), r.ID, api.PostMessageRequest{RequestKey: "with-file", AttachmentIds: []string{draft.Id}})
	if err != nil {
		t.Fatal(err)
	}
	if res.JSON201 == nil {
		t.Fatalf("post=%d %s", res.StatusCode(), res.Body)
	}
	posted := *res.JSON201
	if len(posted.Attachments) != 1 || posted.Attachments[0].Availability != api.AttachmentAvailabilityPosted {
		t.Fatalf("posted=%+v", posted)
	}
	event := nextEvent(t, ws)
	live, err := event.Payload.AsMessage()
	if err != nil || event.Type != api.EventTypeMessageCreated || !reflect.DeepEqual(live, posted) {
		t.Fatalf("event=%+v err=%v", event, err)
	}
	history := history(t, other, r.ID, api.ListMessagesParams{})
	if len(history) != 1 || !reflect.DeepEqual(history[0], posted) {
		t.Fatalf("history=%+v", history)
	}
	status, headers, out := attachmentRequest(t, p, otherHTTP, "GET", draft.ContentUrl, "", nil)
	disposition, params, err := mime.ParseMediaType(headers.Get("Content-Disposition"))
	if status != 200 || !bytes.Equal(out, data) || disposition != "attachment" || strings.Contains(params["filename"], "/") || err != nil || headers.Get("Cache-Control") != "private, no-cache" || headers.Get("X-Content-Type-Options") != "nosniff" || headers.Get("Content-Length") != strconv.Itoa(len(data)) {
		t.Fatalf("content=%d %v %q", status, headers, out)
	}

	status, _, out = attachmentRequest(t, p, hc, "DELETE", "/api/attachments/"+draft.Id, "", nil)
	wantError(t, "cannot cancel posted", status, out, 404, "attachment_not_found")
	text := postedMessageForAttachments(t, b, r.ID, "text-only", api.PostMessageRequest{Body: "text"})
	if text.Attachments == nil || len(text.Attachments) != 0 {
		t.Fatalf("text attachments=%+v", text.Attachments)
	}
}

func TestAttachmentContentRevalidation(t *testing.T) {
	p := startPublic(t, 10)
	room := p.createRoom(t, "Lounge")
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	other, otherHTTP := p.browserWithHTTP(t)
	p.enter(t, other, "Alice")
	data := []byte("immutable content")
	draft := uploadDraft(t, p, hc, room.ID, "file.txt", data)
	status, headers, out := attachmentRequest(t, p, hc, "GET", draft.ContentUrl, "", nil)
	etag := headers.Get("ETag")
	if status != 200 || !bytes.Equal(out, data) || etag != strconv.Quote(draft.Id) || headers.Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("first read=%d %v %q", status, headers, out)
	}
	for _, tc := range []struct {
		name   string
		tags   []string
		status int
	}{
		{"same", []string{etag}, 304},
		{"weak", []string{"W/" + etag}, 304},
		{"list", []string{`"other", W/` + etag}, 304},
		{"multiple fields", []string{`"other"`, etag}, 304},
		{"wildcard", []string{"*"}, 304},
		{"different", []string{`"other"`}, 200},
		{"comma inside tag", []string{`"other,*,tag"`}, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, headers, out := attachmentRequest(t, p, hc, "GET", draft.ContentUrl, "", nil, http.Header{"If-None-Match": tc.tags})
			if status != tc.status || headers.Get("ETag") != etag || headers.Get("Cache-Control") != "private, no-cache" {
				t.Fatalf("revalidation=%d %v %q", status, headers, out)
			}
			if status == 304 && (len(out) != 0 || headers.Get("Content-Length") != "") {
				t.Fatalf("304 carries content: %v %q", headers, out)
			}
			if status == 200 && !bytes.Equal(out, data) {
				t.Fatalf("changed validator lost bytes: %q", out)
			}
		})
	}
	conditional := http.Header{"If-None-Match": {etag}}
	for _, tc := range []struct {
		name   string
		client *http.Client
		status int
		code   string
	}{
		{"no cookie", p.srv.Client(), 401, "visitor_required"},
		{"foreign draft", otherHTTP, 404, "attachment_not_found"},
	} {
		status, headers, out := attachmentRequest(t, p, tc.client, "GET", draft.ContentUrl, "", nil, conditional)
		wantError(t, tc.name, status, out, tc.status, tc.code)
		if headers.Get("Cache-Control") != "no-store" || headers.Get("ETag") != "" {
			t.Fatalf("cached error=%v", headers)
		}
	}
	postedMessageForAttachments(t, b, room.ID, "posted", api.PostMessageRequest{AttachmentIds: []string{draft.Id}})
	status, _, _ = attachmentRequest(t, p, otherHTTP, "GET", draft.ContentUrl, "", nil, conditional)
	if status != 304 {
		t.Fatalf("posted revalidation=%d", status)
	}
	if _, err := p.identity.Rotate(t.Context()); err != nil {
		t.Fatal(err)
	}
	status, headers, out = attachmentRequest(t, p, hc, "GET", draft.ContentUrl, "", nil, conditional)
	wantError(t, "revoked conditional read", status, out, 401, "visitor_required")
	if headers.Get("Cache-Control") != "no-store" || headers.Get("ETag") != "" {
		t.Fatalf("cached revocation=%v", headers)
	}
}

func TestAttachmentRevalidationChecksAvailability(t *testing.T) {
	for _, state := range []string{"cancelled", "expired", "missing", "evicted"} {
		t.Run(state, func(t *testing.T) {
			p := startPublicAttachments(t, 10, 100, []attachments.Option{attachments.WithPostedQuota(6)})
			room := p.createRoom(t, "Lounge")
			b, hc := p.browserWithHTTP(t)
			visitor := p.enter(t, b, "Bob")
			draft := uploadDraft(t, p, hc, room.ID, "file.txt", []byte("data"))
			_, headers, _ := attachmentRequest(t, p, hc, "GET", draft.ContentUrl, "", nil)
			switch state {
			case "cancelled":
				status, _, out := attachmentRequest(t, p, hc, "DELETE", "/api/attachments/"+draft.Id, "", nil)
				if status != 204 {
					t.Fatalf("cancel=%d %s", status, out)
				}
			case "expired":
				p.clock.Advance(time.Hour + time.Second)
			case "missing":
				content, err := p.attachments.Open(t.Context(), visitor.Id, draft.Id)
				if err != nil {
					t.Fatal(err)
				}
				name := content.File.Name()
				if err := content.File.Close(); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
			case "evicted":
				postedMessageForAttachments(t, b, room.ID, "first", api.PostMessageRequest{AttachmentIds: []string{draft.Id}})
				next := uploadDraft(t, p, hc, room.ID, "next.txt", []byte("next"))
				postedMessageForAttachments(t, b, room.ID, "next", api.PostMessageRequest{AttachmentIds: []string{next.Id}})
			}
			for _, tag := range []string{headers.Get("ETag"), "*"} {
				status, headers, out := attachmentRequest(t, p, hc, "GET", draft.ContentUrl, "", nil, http.Header{"If-None-Match": {tag}})
				wantError(t, "unavailable conditional read", status, out, 410, "attachment_expired")
				if headers.Get("Cache-Control") != "no-store" || headers.Get("ETag") != "" {
					t.Fatalf("cached unavailable=%v", headers)
				}
			}
		})
	}
}

func postedMessageForAttachments(t *testing.T, b *api.ClientWithResponses, room, key string, body api.PostMessageRequest) api.Message {
	t.Helper()
	body.RequestKey = key
	res, err := b.PostMessageWithResponse(t.Context(), room, body)
	if err != nil || res.JSON201 == nil {
		t.Fatalf("post=%+v err=%v", res, err)
	}
	return *res.JSON201
}

func TestMultipartLimitsAndLaterFailureReclaimDrafts(t *testing.T) {
	for _, tc := range []struct {
		name   string
		size   int
		suffix string
		status int
	}{
		{"exact file limit", 25 << 20, "", 201},
		{"file over limit", (25 << 20) + 1, "", 413},
		{"extra part", 4, "extra", 400},
		{"incomplete envelope", 4, "truncated", 400},
		{"epilogue over limit", 4, "epilogue", 413},
		{"header over limit", 4, "header", 413},
		{"long filename", 4, "filename", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := startPublic(t, 10)
			room := p.createRoom(t, "Lounge")
			b, hc := p.browserWithHTTP(t)
			p.enter(t, b, "Bob")
			var buf bytes.Buffer
			mw := multipart.NewWriter(&buf)
			filename := "file.bin"
			if tc.suffix == "filename" {
				filename = strings.Repeat("a", 256)
			}
			if tc.suffix == "header" {
				filename = strings.Repeat("a", 9000)
			}
			part, err := mw.CreateFormFile("file", filename)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := io.CopyN(part, strings.NewReader(strings.Repeat("x", tc.size)), int64(tc.size)); err != nil {
				t.Fatal(err)
			}
			if tc.suffix == "extra" {
				if err := mw.WriteField("extra", "bad"); err != nil {
					t.Fatal(err)
				}
			}
			if err := mw.Close(); err != nil {
				t.Fatal(err)
			}
			data := buf.Bytes()
			if tc.suffix == "truncated" {
				data = data[:len(data)-12]
			}
			if tc.suffix == "epilogue" {
				data = append(data, bytes.Repeat([]byte("x"), 20<<10)...)
			}
			status, _, out := attachmentRequest(t, p, hc, "POST", "/api/rooms/"+room.ID+"/attachments", mw.FormDataContentType(), bytes.NewReader(data))
			if status != tc.status {
				t.Fatalf("upload=%d %s want %d", status, out, tc.status)
			}
			if status != 201 {
				// Later envelope failures must not consume any of the four draft slots.
				p.clock.Advance(time.Minute)
				for i := range 4 {
					uploadDraft(t, p, hc, room.ID, strconv.Itoa(i), []byte("ok"))
				}
			}
		})
	}
}

func TestDraftCancelExpiryAndOriginPrivacy(t *testing.T) {
	p := startPublic(t, 10)
	room := p.createRoom(t, "Lounge")
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	draft := uploadDraft(t, p, hc, room.ID, "file.txt", []byte("private"))
	req, err := http.NewRequestWithContext(t.Context(), "DELETE", p.srv.URL+"/api/attachments/"+draft.Id, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "https://evil.example")
	res, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("foreign cancel=%d", res.StatusCode)
	}
	for range 2 {
		status, _, out := attachmentRequest(t, p, hc, "DELETE", "/api/attachments/"+draft.Id, "", nil)
		if status != 204 {
			t.Fatalf("cancel=%d %s", status, out)
		}
	}
	status, _, out := attachmentRequest(t, p, hc, "GET", draft.ContentUrl, "", nil)
	wantError(t, "cancelled content", status, out, 410, "attachment_expired")
	expiring := uploadDraft(t, p, hc, room.ID, "expires.txt", []byte("expires"))
	p.clock.Advance(time.Hour + time.Second)
	status, _, out = attachmentRequest(t, p, hc, "GET", "/api/attachments/"+expiring.Id, "", nil)
	var metadata api.Attachment
	if err := json.Unmarshal(out, &metadata); err != nil || status != 200 || metadata.Availability != api.AttachmentAvailabilityExpired {
		t.Fatalf("expired status=%d %s %v", status, out, err)
	}
	status, _, out = attachmentRequest(t, p, hc, "GET", expiring.ContentUrl, "", nil)
	wantError(t, "expired content", status, out, 410, "attachment_expired")
}

func TestQuotaExpiryEventAndReconnectStatus(t *testing.T) {
	p := startPublicAttachments(t, 10, 100, []attachments.Option{attachments.WithPostedQuota(6)})
	room := p.createRoom(t, "Lounge")
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	first := uploadDraft(t, p, hc, room.ID, "first.txt", []byte("one!"))
	created := postedMessageForAttachments(t, b, room.ID, "first", api.PostMessageRequest{Body: "keep text", AttachmentIds: []string{first.Id}})
	ws := p.connectLive(t, hc)
	second := uploadDraft(t, p, hc, room.ID, "second.txt", []byte("two!"))
	postedMessageForAttachments(t, b, room.ID, "second", api.PostMessageRequest{AttachmentIds: []string{second.Id}})
	e := nextEvent(t, ws)
	expired, err := e.Payload.AsAttachmentsExpired()
	if err != nil || e.Type != api.EventTypeAttachmentsExpired || e.RoomId != room.ID || !reflect.DeepEqual(expired.AttachmentIds, []string{first.Id}) {
		t.Fatalf("expiry=%+v payload=%+v err=%v", e, expired, err)
	}
	if next := nextEvent(t, ws); next.Type != api.EventTypeMessageCreated {
		t.Fatalf("after expiry=%+v", next)
	}
	status, _, out := attachmentRequest(t, p, hc, "GET", "/api/attachments/"+first.Id, "", nil)
	var metadata api.Attachment
	if err := json.Unmarshal(out, &metadata); err != nil || status != 200 || metadata.Availability != api.AttachmentAvailabilityExpired {
		t.Fatalf("refresh=%d %s", status, out)
	}
	retry, err := b.PostMessageWithResponse(t.Context(), room.ID, api.PostMessageRequest{RequestKey: "first", Body: "keep text", AttachmentIds: []string{first.Id}})
	if err != nil || retry.JSON200 == nil || retry.JSON200.Id != created.Id || retry.JSON200.Attachments[0].Availability != api.AttachmentAvailabilityExpired {
		t.Fatalf("retry=%+v %v", retry, err)
	}
	status, _, out = attachmentRequest(t, p, hc, "GET", second.ContentUrl, "", nil)
	if status != 200 || string(out) != "two!" {
		t.Fatalf("retry evicted latest=%d %s", status, out)
	}
}

func TestAttachmentAccessAfterLinkRotation(t *testing.T) {
	p := startPublic(t, 10)
	room := p.createRoom(t, "Lounge")
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	posted := uploadDraft(t, p, hc, room.ID, "posted.txt", []byte("posted"))
	draft := uploadDraft(t, p, hc, room.ID, "draft.txt", []byte("draft"))
	postedMessageForAttachments(t, b, room.ID, "posted", api.PostMessageRequest{AttachmentIds: []string{posted.Id}})
	link, err := p.identity.Rotate(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	status, _, out := attachmentRequest(t, p, hc, "GET", posted.ContentUrl, "", nil)
	wantError(t, "old cookie", status, out, 401, "visitor_required")
	newBrowser, newHTTP := p.browserWithHTTP(t)
	p.secret = strings.TrimPrefix(link, testOrigin+"/#k=")
	p.enter(t, newBrowser, "New visitor")
	status, _, out = attachmentRequest(t, p, newHTTP, "GET", posted.ContentUrl, "", nil)
	if status != 200 || string(out) != "posted" {
		t.Fatalf("new visitor posted read=%d %s", status, out)
	}
	status, _, out = attachmentRequest(t, p, newHTTP, "GET", "/api/attachments/"+draft.Id, "", nil)
	wantError(t, "new visitor draft", status, out, 404, "attachment_not_found")
}

func TestEffectiveAttachmentLimitsAndJSONCap(t *testing.T) {
	p := startPublicAttachments(t, 10, 100, []attachments.Option{attachments.WithPostedQuota(123)})
	room := p.createRoom(t, "Lounge")
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	status, _, out := attachmentRequest(t, p, hc, "GET", "/api/attachments/limits", "", nil)
	var limits api.AttachmentLimits
	if err := json.Unmarshal(out, &limits); err != nil || status != 200 || limits.PostedBytes != 123 || limits.MaxFileBytes != 26214400 || limits.MaxUploadStreams != 4 || limits.MaxContentStreams != 8 || limits.UploadTimeoutSeconds != 60 {
		t.Fatalf("limits=%d %s %v", status, out, err)
	}
	status, _, out = attachmentRequest(t, p, hc, "POST", "/api/rooms/"+room.ID+"/messages", "application/json", strings.NewReader(`{"requestKey":"large","body":"`+strings.Repeat("x", 65<<10)+`"}`))
	if status != 400 || !strings.Contains(string(out), "request body too large") {
		t.Fatalf("JSON cap=%d %s", status, out)
	}
	bad := uploadDraft(t, p, hc, room.ID, "small", []byte("abcd"))
	res, err := b.PostMessageWithResponse(t.Context(), room.ID, api.PostMessageRequest{RequestKey: "invalid", AttachmentIds: []string{bad.Id, bad.Id}})
	if err != nil || res.StatusCode() != 400 || res.JSON400.Code != "invalid_attachments" {
		t.Fatalf("duplicate=%+v %v", res, err)
	}
}

type blockedContent struct {
	header   http.Header
	started  chan struct{}
	release  <-chan struct{}
	once     sync.Once
	deadline time.Time
}

func (w *blockedContent) Header() http.Header { return w.header }
func (*blockedContent) WriteHeader(int)       {}
func (w *blockedContent) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}

func (w *blockedContent) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.release
	return len(p), nil
}

func TestContentStreamsBoundAcrossHandlersAndCloseOnCompletion(t *testing.T) {
	p := startPublic(t, 10)
	room := p.createRoom(t, "Lounge")
	b, hc := p.browserWithHTTP(t)
	p.enter(t, b, "Bob")
	draft := uploadDraft(t, p, hc, room.ID, "file", []byte("content"))
	_, token, err := p.identity.Enter(t.Context(), p.secret, "Reader")
	if err != nil {
		t.Fatal(err)
	}
	postedMessageForAttachments(t, b, room.ID, "posted", api.PostMessageRequest{AttachmentIds: []string{draft.Id}})
	release := make(chan struct{})
	done := make(chan struct{}, 8)
	defer close(release)
	alternate := New(Deps{Metrics: http.NotFoundHandler(), Logger: platform.NewLogger(io.Discard, 0), Identity: p.identity, Rooms: p.rooms, Attachments: p.attachments}).Public
	for index := range 8 {
		writer := &blockedContent{header: http.Header{}, started: make(chan struct{}), release: release}
		req := httptest.NewRequestWithContext(t.Context(), "GET", draft.ContentUrl, nil)
		req.AddCookie(&http.Cookie{Name: cookieName, Value: token})
		handler := p.srv.Config.Handler
		if index%2 == 1 {
			handler = alternate
		}
		go func() { handler.ServeHTTP(writer, req); done <- struct{}{} }()
		select {
		case <-writer.started:
		case <-time.After(time.Second):
			t.Fatal("content did not start")
		}
		if remaining := time.Until(writer.deadline); remaining < 119*time.Second || remaining > 121*time.Second {
			t.Fatalf("content deadline=%v", remaining)
		}
	}
	status, _, out := attachmentRequest(t, p, hc, "GET", draft.ContentUrl, "", nil)
	wantError(t, "saturated content", status, out, 429, "attachment_busy")
	status, _, out = attachmentRequest(t, p, hc, "GET", draft.ContentUrl, "", nil, http.Header{"If-None-Match": {strconv.Quote(draft.Id)}})
	if status != 304 || len(out) != 0 {
		t.Fatalf("revalidation while streams are busy=%d %s", status, out)
	}
	// Close the readers before proving that all slots and file handles return.
	for range 8 {
		release <- struct{}{}
	}
	for range 8 {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("content did not finish")
		}
	}
	status, _, out = attachmentRequest(t, p, hc, "GET", draft.ContentUrl, "", nil)
	if status != 200 || string(out) != "content" {
		t.Fatalf("after content completion=%d %s", status, out)
	}
}

type blockedHeaderBody struct {
	started chan struct{}
	release <-chan struct{}
	once    sync.Once
}

func (b *blockedHeaderBody) Read([]byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	<-b.release
	return 0, io.EOF
}
func (*blockedHeaderBody) Close() error { return nil }

type readDeadlineRecorder struct {
	*httptest.ResponseRecorder
	deadline time.Time
}

func (w *readDeadlineRecorder) SetReadDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}

func TestMultipartHeaderAdmissionRejectsBeforeReading(t *testing.T) {
	p := startPublic(t, 10)
	room := p.createRoom(t, "Lounge")
	_, token, err := p.identity.Enter(t.Context(), p.secret, "Bob")
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	defer close(release)
	done := make(chan struct{}, 4)
	request := func(body io.Reader) *http.Request {
		req := httptest.NewRequestWithContext(t.Context(), "POST", "/api/rooms/"+room.ID+"/attachments", body)
		req.Header.Set("Content-Type", "multipart/form-data; boundary=test")
		req.AddCookie(&http.Cookie{Name: cookieName, Value: token})
		return req
	}
	for range 4 {
		body := &blockedHeaderBody{started: make(chan struct{}), release: release}
		writer := &readDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
		go func() { p.srv.Config.Handler.ServeHTTP(writer, request(body)); done <- struct{}{} }()
		select {
		case <-body.started:
		case <-time.After(time.Second):
			t.Fatal("multipart header read did not start")
		}
		if remaining := time.Until(writer.deadline); remaining < 59*time.Second || remaining > 61*time.Second {
			t.Fatalf("read deadline=%v", remaining)
		}
	}
	body := &unreadBody{}
	writer := &readDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	p.srv.Config.Handler.ServeHTTP(writer, request(body))
	if writer.Code != 429 || body.reads != 0 {
		t.Fatalf("header saturation status=%d reads=%d body=%s", writer.Code, body.reads, writer.Body)
	}
	for range 4 {
		release <- struct{}{}
	}
	for range 4 {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("header reader did not stop")
		}
	}
}
