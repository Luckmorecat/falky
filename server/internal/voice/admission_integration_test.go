//go:build integration

package voice_test

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

type heldUpgrade struct {
	io.ReadWriteCloser
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (h *heldUpgrade) Read(p []byte) (int, error) {
	h.once.Do(func() { close(h.entered); <-h.release })
	return h.ReadWriteCloser.Read(p)
}

func heldGuard(t *testing.T, f guardedVoice) (*httptest.Server, <-chan struct{}, func()) {
	t.Helper()
	target, err := url.Parse(f.voiceURL())
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(res *http.Response) error {
		if res.StatusCode == 101 {
			res.Body = &heldUpgrade{ReadWriteCloser: res.Body.(io.ReadWriteCloser), entered: entered, release: release}
		}
		return nil
	}
	upstream := httptest.NewServer(proxy)
	t.Cleanup(upstream.Close)
	guard := httptest.NewServer(f.voice.Signalling(upstream.URL))
	f.voice.ConfigureAdmission(f.gate, f.ident.ValidateSession, guard.URL)
	t.Cleanup(guard.Close)
	t.Cleanup(unblock)
	return guard, entered, unblock
}

func (f guardedVoice) voiceURL() string { return "http://127.0.0.1:" + strconv.Itoa(liveKitPort) }

func TestGuardedLiveKitAdmissionAndRevocationShareCompleteHandshakeFence(t *testing.T) {
	f := newGuardedVoice(t)
	guard, entered, release := heldGuard(t, f)
	defer release()
	f.public = guard
	account, _ := f.enroll(t)
	creds := f.join(t, account.Session)
	// The fixture's URL assertion uses the main listener; this additional
	// guard exercises a deliberately delayed real upstream handshake.
	creds.URL = "ws" + strings.TrimPrefix(guard.URL, "http")
	dialed := make(chan *websocket.Conn, 1)
	go func() {
		ws, res, _ := websocket.Dial(t.Context(), guard.URL+"/rtc?protocol=15&access_token="+url.QueryEscape(creds.Token), nil)
		if res != nil && res.Body != nil {
			_ = res.Body.Close()
		}
		dialed <- ws
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream handshake never reached first message")
	}
	revoked := make(chan error, 1)
	go func() {
		f.gate.Lock()
		defer f.gate.Unlock()
		effects, err := f.ident.DisableAccount(t.Context(), account.Session.Visitor.ID)
		if err == nil {
			err = f.gate.Apply(t.Context(), effects)
		}
		revoked <- err
	}()
	select {
	case err := <-revoked:
		t.Fatalf("revocation passed unfinished handshake: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	release()
	if err := <-revoked; err != nil {
		t.Fatal(err)
	}
	ws := <-dialed
	if ws != nil {
		defer func() { _ = ws.CloseNow() }()
	}
	waitForParticipants(t, liveKitClient(), f.room)
	refusedAtGuard(t, f, creds.Token)
}

func TestGuardedLiveKitCancelledHandshakeClosesOnlyFailedAttemptAndAllowsRetry(t *testing.T) {
	for _, kind := range []identity.Kind{identity.Guest, identity.Account} {
		for _, immediate := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/immediate=%t", kind, immediate), func(t *testing.T) {
				f := newGuardedVoice(t)
				guard, entered, release := heldGuard(t, f)
				defer release()
				session := guardedSession(t, f, kind)
				f.gate.Lock()
				creds, err := f.voice.JoinSession(t.Context(), session, f.room)
				f.gate.Unlock()
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				done := make(chan struct{})
				go func() {
					ws, res, _ := websocket.Dial(ctx, guard.URL+"/rtc?protocol=15&access_token="+url.QueryEscape(creds.Token), nil)
					if ws != nil {
						_ = ws.CloseNow()
					}
					if res != nil && res.Body != nil {
						_ = res.Body.Close()
					}
					close(done)
				}()
				select {
				case <-entered:
				case <-time.After(2 * time.Second):
					t.Fatal("upstream handshake not reached")
				}
				cancel()
				<-done
				gateFree := make(chan struct{})
				go func() {
					f.gate.Lock()
					defer f.gate.Unlock()
					close(gateFree)
				}()
				select {
				case <-gateFree:
				case <-time.After(2 * time.Second):
					t.Fatal("cancelled handshake held lifecycle gate")
				}
				if !immediate {
					release()
					waitForParticipants(t, liveKitClient(), f.room)
				}
				// No new Join: the original exact grant remains valid. Closing the old
				// source after this reconnect must not remove its replacement participant.
				creds.URL = "ws" + strings.TrimPrefix(f.public.URL, "http")
				client := connect(t, creds)
				release()
				waitForParticipants(t, liveKitClient(), f.room, creds.GrantID)
				if err := f.voice.Refresh(t.Context()); err != nil {
					t.Fatal(err)
				}
				select {
				case <-client.disconnected:
					t.Fatal("failed source cleanup removed successful retry")
				case <-time.After(100 * time.Millisecond):
				}
			})
		}
	}
}

func TestGuardedLiveKitRejectsChangedRoomSignatureAndOldGuestAfterUpgrade(t *testing.T) {
	f := newGuardedVoice(t)
	account, _ := f.enroll(t)
	creds := f.join(t, account.Session)
	verifier, err := auth.ParseAPIToken(creds.Token)
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []struct{ key, secret, room string }{{devKey, devSecret, "another-room"}, {devKey, "wrong-signature", f.room}, {"another-signer", devSecret, f.room}} {
		token, err := auth.NewAccessToken(invalid.key, invalid.secret).SetIdentity(verifier.Identity()).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: invalid.room}).ToJWT()
		if err != nil {
			t.Fatal(err)
		}
		refusedAtGuard(t, f, token)
	}
	link, err := f.ident.Link(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	guest, token, err := f.ident.Enter(t.Context(), strings.TrimPrefix(link, "https://falky.example/#k="), "Guest")
	if err != nil {
		t.Fatal(err)
	}
	session, err := f.ident.ResolveSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	f.gate.Lock()
	old, err := f.voice.JoinSession(t.Context(), session, f.room)
	f.gate.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	old.URL = "ws" + strings.TrimPrefix(f.public.URL, "http")
	connect(t, old)
	invite, err := f.ident.CreateInvitation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	c, err := f.ident.BeginRegistration(t.Context(), identity.RegistrationInput{Invitation: invite.Token, GuestToken: token, Name: guest.Name, BrowserContext: "upgrade"})
	if err != nil {
		t.Fatal(err)
	}
	key := passkeytest.New(t)
	f.gate.Lock()
	upgraded, err := f.ident.FinishRegistration(t.Context(), c.ID, "upgrade", key.Registration(t, c.Creation, "https://falky.example"), "Passkey")
	if err == nil {
		err = f.gate.Apply(t.Context(), upgraded.Effects)
	}
	f.gate.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	refusedAtGuard(t, f, old.Token)
	connect(t, f.join(t, upgraded.Session))
}

func TestGuardedLiveKitSupportsBrowserV1Signalling(t *testing.T) {
	f := newGuardedVoice(t)
	account, _ := f.enroll(t)
	creds := f.join(t, account.Session)
	request, err := proto.Marshal(&livekit.JoinRequest{ClientInfo: &livekit.ClientInfo{Protocol: 17, Sdk: livekit.ClientInfo_JS}, ConnectionSettings: &livekit.ConnectionSettings{AutoSubscribe: false}})
	if err != nil {
		t.Fatal(err)
	}
	wrapped, err := proto.Marshal(&livekit.WrappedJoinRequest{Compression: livekit.WrappedJoinRequest_NONE, JoinRequest: request})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	ws, res, err := websocket.Dial(ctx, f.public.URL+"/rtc/v1?access_token="+url.QueryEscape(creds.Token)+"&join_request="+url.QueryEscape(base64.URLEncoding.EncodeToString(wrapped)), nil)
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ws.CloseNow() }()
	_, data, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var response livekit.SignalResponse
	if err := proto.Unmarshal(data, &response); err != nil {
		t.Fatal(err)
	}
	if response.GetJoin().GetParticipant().GetIdentity() == "" {
		t.Fatal("browser v1 did not receive Join response")
	}
	f.gate.Lock()
	effects, err := f.ident.DisableAccount(t.Context(), account.Session.Visitor.ID)
	if err == nil {
		err = f.gate.Apply(t.Context(), effects)
	}
	f.gate.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	refusedAtGuard(t, f, creds.Token)
}
