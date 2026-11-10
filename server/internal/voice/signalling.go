package voice

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/rooms"
)

type signalConnection struct {
	upstream, downstream *websocket.Conn
	once                 sync.Once
}

func (c *signalConnection) revoke(ctx context.Context) {
	data, err := proto.Marshal(&livekit.SignalResponse{Message: &livekit.SignalResponse_Leave{Leave: &livekit.LeaveRequest{Reason: livekit.DisconnectReason_PARTICIPANT_REMOVED, Action: livekit.LeaveRequest_DISCONNECT}}})
	if err == nil {
		_ = c.downstream.Write(ctx, websocket.MessageBinary, data)
	}
	c.close()
}

func (c *signalConnection) close() {
	c.once.Do(func() { _ = c.upstream.CloseNow(); _ = c.downstream.CloseNow() })
}

// Signalling exposes only the SDK's signalling and validation paths. It never
// forwards management APIs. The upstream is independent of the public alias.
func (s *Service) Signalling(upstream string) http.Handler {
	target, err := url.Parse(upstream)
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "voice unavailable", http.StatusServiceUnavailable)
		})
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "voice unavailable", http.StatusBadGateway)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Falky-RTC-Guard", "1")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet || (r.URL.Path != "/rtc" && r.URL.Path != "/rtc/v1" && r.URL.Path != "/rtc/validate" && r.URL.Path != "/rtc/v1/validate") {
			http.NotFound(w, r)
			return
		}
		if s.admission == nil || s.validate == nil {
			http.Error(w, "voice unavailable", http.StatusServiceUnavailable)
			return
		}
		s.admission.Lock()
		locked := true
		defer func() {
			if locked {
				s.admission.Unlock()
			}
		}()
		handshakeCtx, finishHandshake := context.WithTimeout(r.Context(), 10*time.Second)
		defer finishHandshake()
		g, err := s.admit(r.WithContext(handshakeCtx))
		if err != nil {
			status := http.StatusForbidden
			if !errors.Is(err, identity.ErrNoVisitor) {
				status = http.StatusServiceUnavailable
			}
			http.Error(w, "voice admission refused", status)
			return
		}
		if err := s.checkLease(handshakeCtx, g, false); err != nil {
			http.Error(w, "voice admission refused", admissionStatus(err))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/validate") {
			proxy.ServeHTTP(w, r.WithContext(handshakeCtx))
			return
		}
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "WebSocket required", http.StatusBadRequest)
			return
		}
		acceptOptions := &websocket.AcceptOptions{InsecureSkipVerify: true}
		if !validateHandshake(w, r, acceptOptions) {
			return
		}
		if err := s.checkLease(handshakeCtx, g, true); err != nil {
			http.Error(w, "voice admission refused", admissionStatus(err))
			return
		}
		reserved := true
		defer func() {
			if reserved {
				s.releaseLease(g)
			}
		}()
		u := *target
		u.Scheme = "ws" + strings.TrimPrefix(u.Scheme, "http")
		u.Path, u.RawQuery = r.URL.Path, r.URL.RawQuery
		headers := http.Header{}
		if authHeader := r.Header.Get("Authorization"); authHeader != "" {
			headers.Set("Authorization", authHeader)
		}
		ctx := handshakeCtx
		up, res, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPHeader: headers})
		if err != nil {
			if res != nil && res.Body != nil {
				_ = res.Body.Close()
			}
			http.Error(w, "voice unavailable", http.StatusBadGateway)
			return
		}
		up.SetReadLimit(1 << 20)
		// HTTP 101 precedes participant creation. Wait for LiveKit's first
		// Join/Reconnect response before releasing the mutation gate, so an
		// already checked handshake cannot attach after its removal.
		// A failed attempt closes only its own signal source. Management
		// removal addresses identity and could remove a concurrent retry.
		type frame struct {
			typ  websocket.MessageType
			data []byte
			err  error
		}
		firstFrame := make(chan frame, 1)
		readCtx, stopRead := context.WithCancel(context.WithoutCancel(r.Context()))
		defer stopRead()
		go func() { typ, data, err := up.Read(readCtx); firstFrame <- frame{typ: typ, data: data, err: err} }()
		var received frame
		select {
		case received = <-firstFrame:
		case <-ctx.Done():
			received.err = ctx.Err()
		}
		typ, first, err := received.typ, received.data, received.err
		var response livekit.SignalResponse
		if err == nil {
			if typ == websocket.MessageBinary {
				err = proto.Unmarshal(first, &response)
			} else {
				err = protojson.Unmarshal(first, &response)
			}
		}
		if err != nil || (response.GetJoin() == nil && response.GetReconnect() == nil) {
			// LiveKit tears down this attempt when its signal source closes.
			_ = up.CloseNow()
			http.Error(w, "voice handshake failed", http.StatusBadGateway)
			return
		}
		if err := s.connected(ctx, g); err != nil {
			_ = up.CloseNow()
			http.Error(w, "voice admission refused", admissionStatus(err))
			return
		}
		down, err := websocket.Accept(w, r, acceptOptions)
		if err != nil {
			_ = up.CloseNow()
			return
		}
		down.SetReadLimit(1 << 20)
		connection := &signalConnection{upstream: up, downstream: down}
		s.mu.Lock()
		g.sockets[connection] = struct{}{}
		s.mu.Unlock()
		s.releaseLease(g)
		reserved = false
		s.admission.Unlock()
		locked = false
		defer func() { connection.close(); s.mu.Lock(); delete(g.sockets, connection); s.mu.Unlock() }()
		if err := down.Write(ctx, typ, first); err != nil {
			return
		}
		streamCtx, stop := context.WithCancel(r.Context())
		defer stop()
		done := make(chan struct{})
		go func() { defer close(done); relaySignals(streamCtx, up, down); connection.close() }()
		relaySignals(streamCtx, down, up)
		connection.close()
		<-done
	})
}

func relaySignals(ctx context.Context, from, to *websocket.Conn) {
	for {
		typ, reader, err := from.Reader(ctx)
		if err != nil {
			return
		}
		writer, err := to.Writer(ctx, typ)
		if err != nil {
			return
		}
		_, err = io.Copy(writer, reader)
		closeErr := writer.Close()
		if err != nil || closeErr != nil {
			return
		}
	}
}

func (s *Service) admit(r *http.Request) (*voiceGrant, error) {
	token := r.URL.Query().Get("access_token")
	header := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == "" {
		token = header
	} else if header != "" && header != token {
		return nil, identity.ErrNoVisitor
	}
	verifier, err := auth.ParseAPIToken(token)
	if err != nil || verifier.APIKey() != s.cfg.APIKey {
		return nil, identity.ErrNoVisitor
	}
	claims, grants, err := verifier.Verify(s.cfg.APISecret)
	if err != nil || claims.ExpiresAt == nil || !time.Now().Before(claims.ExpiresAt.Time) || grants.Video == nil || !grants.Video.RoomJoin || grants.Video.Room == "" || grants.Video.RoomAdmin || grants.Video.RoomCreate || grants.Video.RoomList || grants.Video.RoomRecord || grants.Video.IngressAdmin || grants.Video.Agent {
		return nil, identity.ErrNoVisitor
	}
	g, err := s.grant(r.Context(), grants.Identity)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	refused := g == nil || g.revoked || g.room != grants.Video.Room
	s.mu.Unlock()
	if refused {
		return nil, identity.ErrNoVisitor
	}
	if requested := r.URL.Query().Get("room"); requested != "" && requested != g.room {
		return nil, identity.ErrNoVisitor
	}
	current, err := s.validate(r.Context(), g.session)
	if err != nil {
		return nil, err
	}
	if err := s.rooms.Authorize(r.Context(), current.Visitor, g.room, rooms.JoinVoice); err != nil {
		if errors.Is(err, rooms.ErrNotFound) || errors.Is(err, identity.ErrNameTaken) {
			return nil, identity.ErrNoVisitor
		}
		return nil, err
	}
	return g, nil
}

func admissionStatus(err error) int {
	if errors.Is(err, identity.ErrNoVisitor) {
		return http.StatusForbidden
	}
	return http.StatusServiceUnavailable
}

var errHandshakeValidated = errors.New("websocket handshake validated")

// validateHandshake lets Accept validate the complete request before upstream
// admission can renew its lease. Refusing the probe's Hijack prevents any I/O;
// the real downstream upgrade still waits for durable upstream success.
func validateHandshake(w http.ResponseWriter, r *http.Request, options *websocket.AcceptOptions) bool {
	probe := &handshakeProbe{header: make(http.Header)}
	_, err := websocket.Accept(probe, r, options)
	if errors.Is(err, errHandshakeValidated) {
		// Accept writes 101 then 500 around the refused Hijack; discard both.
		return true
	}
	for name, values := range probe.header {
		w.Header()[name] = values
	}
	w.WriteHeader(probe.status)
	_, _ = w.Write(probe.body.Bytes())
	return false
}

type handshakeProbe struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (p *handshakeProbe) Header() http.Header { return p.header }
func (p *handshakeProbe) WriteHeader(status int) {
	if p.status == 0 {
		p.status = status
	}
}
func (p *handshakeProbe) Write(data []byte) (int, error) { return p.body.Write(data) }
func (*handshakeProbe) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, errHandshakeValidated
}
