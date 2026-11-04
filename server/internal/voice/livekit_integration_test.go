//go:build integration

package voice_test

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/oklog/ulid/v2"

	"github.com/kisshot/falky/server/internal/identity"
	"github.com/kisshot/falky/server/internal/voice"
)

// liveKitImage is the LiveKit server the adapter is tested against, pinned as
// the deployment pins it.
const liveKitImage = "livekit/livekit-server:v1.13.11@sha256:25cd902de7cacbd5f1f779f6a6ac1eae20ba8f56b0935934ce6b0ab80d1e3d20"

// The API key and secret of livekit-server --dev.
const (
	devKey    = "devkey"
	devSecret = "secret"
)

// liveKitPort is the port of the LiveKit server TestMain starts, which serves
// both its API and its signalling.
var liveKitPort int

// webhookTarget is the Service that LiveKit's webhooks reach while a test
// receives them; they are dropped while it is nil.
var webhookTarget atomic.Pointer[voice.Service]

// TestMain runs livekit-server --dev in Docker for the tests and removes it
// afterwards, sending its webhooks to a receiver on loopback. It runs on the
// host network, bound to loopback: a container on Docker's bridge network may
// not reach the host, and clients reach the media ports LiveKit offers on
// 127.0.0.1.
func TestMain(m *testing.M) {
	code, err := runWithLiveKit(m)
	if err != nil {
		fmt.Fprintln(os.Stderr, "livekit:", err)
		code = 1
	}
	os.Exit(code)
}

func runWithLiveKit(m *testing.M) (int, error) {
	// Bounds starting and removing the container, not the tests.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	ports, err := freePorts(ctx, 3)
	if err != nil {
		return 0, err
	}
	liveKitPort = ports[0]
	var lc net.ListenConfig
	webhookLn, err := lc.Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	receiver := &http.Server{Handler: http.HandlerFunc(receiveWebhook), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = receiver.Serve(webhookLn) }()
	defer func() { _ = receiver.Close() }()
	name := fmt.Sprintf("falky-voice-test-%d", os.Getpid())
	config := fmt.Sprintf("port: %d\nrtc:\n  tcp_port: %d\n  udp_port: %d\n"+
		"webhook:\n  api_key: %s\n  urls:\n    - http://%s/livekit/webhook\n",
		ports[0], ports[1], ports[2], devKey, webhookLn.Addr())
	run := exec.CommandContext(ctx, "docker", "run", "--detach", "--rm", "--name", name, "--network", "host",
		liveKitImage, "--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--config-body", config)
	if out, err := run.CombinedOutput(); err != nil {
		return 0, fmt.Errorf("docker run: %w: %s", err, out)
	}
	defer func() {
		// The container is removed once stopped (--rm).
		_ = exec.CommandContext(context.WithoutCancel(ctx), "docker", "rm", "--force", name).Run()
	}()
	if err := waitForLiveKit(ctx, fmt.Sprintf("http://127.0.0.1:%d/", liveKitPort)); err != nil {
		logs, _ := exec.CommandContext(context.WithoutCancel(ctx), "docker", "logs", name).CombinedOutput()
		return 0, fmt.Errorf("%w; container logs:\n%s", err, logs)
	}
	return m.Run(), nil
}

// receiveWebhook hands a webhook from LiveKit to webhookTarget, if a test
// has set one.
func receiveWebhook(w http.ResponseWriter, r *http.Request) {
	s := webhookTarget.Load()
	if s == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := s.ReceiveWebhook(r); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// receiveWebhooks makes LiveKit's webhooks reach s until the test ends.
func receiveWebhooks(t *testing.T, s *voice.Service) {
	t.Helper()
	webhookTarget.Store(s)
	t.Cleanup(func() { webhookTarget.Store(nil) })
}

// freePorts returns n ports that were free on loopback a moment ago.
func freePorts(ctx context.Context, n int) ([]int, error) {
	var (
		lc    net.ListenConfig
		ports []int
	)
	for range n {
		ln, err := lc.Listen(ctx, "tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		ports = append(ports, ln.Addr().(*net.TCPAddr).Port)
		if err := ln.Close(); err != nil {
			return nil, err
		}
	}
	return ports, nil
}

// waitForLiveKit waits until LiveKit answers its health check at url.
func waitForLiveKit(ctx context.Context, url string) error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
			err = fmt.Errorf("status %d", res.StatusCode)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("LiveKit did not answer at %s within 30s: %w", url, err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func liveKitClient() *voice.Client {
	return voice.NewClient(fmt.Sprintf("http://127.0.0.1:%d", liveKitPort), devKey, devSecret)
}

// liveKitService returns a Service over the LiveKit server under which the
// participants who may stay in a room's voice are visitors in acc.
func liveKitService(roomCap int, acc *access) *voice.Service {
	return voice.New(liveKitClient(), acc, acc, voice.Config{
		URL: fmt.Sprintf("ws://127.0.0.1:%d", liveKitPort), APIKey: devKey, APISecret: devSecret, RoomCap: roomCap,
	})
}

// newVisitor returns a visitor named name with an ID no other test uses.
func newVisitor(name string) identity.Visitor {
	return identity.Visitor{ID: ulid.Make().String(), Name: name}
}

// voiceClient is a client in a room's voice, as a browser is.
type voiceClient struct {
	room *lksdk.Room
	// disconnected receives the reason when the server disconnects it.
	disconnected chan lksdk.DisconnectionReason
}

// connect connects to voice with creds, as a client does, and fails the test
// unless LiveKit accepts the token.
func connect(t *testing.T, creds voice.Credentials) voiceClient {
	t.Helper()
	c, err := tryConnect(creds)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(c.room.Disconnect)
	return c
}

func tryConnect(creds voice.Credentials) (voiceClient, error) {
	c := voiceClient{disconnected: make(chan lksdk.DisconnectionReason, 1)}
	room, err := lksdk.ConnectToRoomWithToken(creds.URL, creds.Token, &lksdk.RoomCallback{
		OnDisconnectedWithReason: func(reason lksdk.DisconnectionReason) {
			select {
			case c.disconnected <- reason:
			default:
			}
		},
	}, lksdk.WithAutoSubscribe(false), lksdk.WithConnectTimeout(10*time.Second))
	c.room = room
	return c, err
}

// waitForParticipants waits until want are exactly the participants listed
// in room.
func waitForParticipants(t *testing.T, lk *voice.Client, room string, want ...string) {
	t.Helper()
	var got []string
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		all, err := lk.Participants(t.Context())
		if err != nil {
			t.Fatalf("Participants: %v", err)
		}
		got = got[:0]
		for _, p := range all {
			if p.Room == room {
				got = append(got, p.Identity)
			}
		}
		slices.Sort(got)
		if slices.Equal(got, want) {
			return
		}
	}
	t.Fatalf("participants of %s = %v, want %v", room, got, want)
}

func TestLiveKitAcceptsTheTokenAndListsTheParticipant(t *testing.T) {
	s, lk := liveKitService(8, newAccess()), liveKitClient()
	room := ulid.Make().String()
	bob := newVisitor("Bob")

	c := connect(t, joined(t, s, bob, room))
	waitForParticipants(t, lk, room, bob.ID)
	if got := c.room.LocalParticipant.Name(); got != "Bob" {
		t.Errorf("participant name = %q, want Bob", got)
	}
	if err := s.Check(t.Context()); err != nil {
		t.Errorf("Check = %v, want nil", err)
	}
}

func TestJoiningAnotherRoomRemovesTheParticipantFromLiveKit(t *testing.T) {
	s, lk := liveKitService(8, newAccess()), liveKitClient()
	first, second := ulid.Make().String(), ulid.Make().String()
	bob := newVisitor("Bob")

	inFirst := connect(t, joined(t, s, bob, first))
	waitForParticipants(t, lk, first, bob.ID)
	toSecond := joined(t, s, bob, second)
	// Removed before the token for the second room was returned.
	waitForParticipants(t, lk, first)
	select {
	case reason := <-inFirst.disconnected:
		if reason != lksdk.ParticipantRemoved {
			t.Errorf("disconnected because %q, want removed", reason)
		}
	case <-time.After(5 * time.Second):
		t.Error("the client in the first room was not disconnected")
	}
	connect(t, toSecond)
	waitForParticipants(t, lk, second, bob.ID)
}

func TestRemovingAnAbsentParticipantSucceeds(t *testing.T) {
	if err := liveKitClient().RemoveParticipant(t.Context(), ulid.Make().String(), "nobody"); err != nil {
		t.Errorf("RemoveParticipant of no one = %v, want nil", err)
	}
}

func TestLiveKitAdmitsNoMoreThanTheCap(t *testing.T) {
	s := liveKitService(1, newAccess())
	room := ulid.Make().String()
	alice, carol := newVisitor("Alice"), newVisitor("Carol")

	// Both are issued tokens before either connects.
	forAlice, forCarol := joined(t, s, alice, room), joined(t, s, carol, room)
	connect(t, forAlice)
	if c, err := tryConnect(forCarol); err == nil {
		c.room.Disconnect()
		t.Error("a second participant connected to a room capped at one")
	}
	if _, err := s.Join(t.Context(), carol, room); !errors.Is(err, voice.ErrRoomFull) {
		t.Errorf("Join of the full room = %v, want ErrRoomFull", err)
	}

	// A second tab of Alice's replaces her first connection.
	connect(t, joined(t, s, alice, room))
	waitForParticipants(t, liveKitClient(), room, alice.ID)
}

func TestAnUnreachableLiveKitIsUnavailable(t *testing.T) {
	ports, err := freePorts(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	lk := voice.NewClient(fmt.Sprintf("http://127.0.0.1:%d", ports[0]), devKey, "a-secret-that-must-not-show")
	s := voice.New(lk, newAccess(), newAccess(), voice.Config{URL: "ws://127.0.0.1:1", APIKey: devKey, APISecret: "a-secret-that-must-not-show", RoomCap: 8})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	err = s.Check(ctx)
	if err == nil {
		t.Fatal("Check = nil, want an error")
	}
	_, joinErr := s.Join(ctx, identity.Visitor{ID: "bob", Name: "Bob"}, "room")
	if !errors.Is(joinErr, voice.ErrUnavailable) {
		t.Errorf("Join = %v, want ErrUnavailable", joinErr)
	}
	for _, e := range []error{err, joinErr} {
		if strings.Contains(e.Error(), "a-secret-that-must-not-show") {
			t.Errorf("error %q contains the API secret", e)
		}
	}
}

func joined(t *testing.T, s *voice.Service, v identity.Visitor, room string) voice.Credentials {
	t.Helper()
	creds, err := s.Join(t.Context(), v, room)
	if err != nil {
		t.Fatalf("Join(%s, %s): %v", v.Name, room, err)
	}
	return creds
}

// withRooms makes the rooms ids exist too.
func (a *access) withRooms(ids ...string) *access {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rooms = append(a.rooms, ids...)
	return a
}

// waitForOccupancy waits until want, in order, is the occupancy s has of room.
func waitForOccupancy(t *testing.T, s *voice.Service, room string, want ...identity.Visitor) {
	t.Helper()
	var got []identity.Visitor
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if got = s.Occupancy(room); slices.Equal(got, want) {
			return
		}
	}
	t.Fatalf("occupancy of %s = %+v, want %+v", room, got, want)
}

// removedOrRefused connects to voice with creds and fails the test unless
// LiveKit refuses the connection or removes it soon after.
func removedOrRefused(t *testing.T, creds voice.Credentials) {
	t.Helper()
	c, err := tryConnect(creds)
	if err != nil {
		return
	}
	defer c.room.Disconnect()
	select {
	case reason := <-c.disconnected:
		if reason != lksdk.ParticipantRemoved {
			t.Errorf("disconnected because %q, want removed", reason)
		}
	case <-time.After(10 * time.Second):
		t.Error("the client was not removed")
	}
}

func TestLiveKitsWebhooksKeepTheViewAndRemoveWhoMayNotStay(t *testing.T) {
	room := ulid.Make().String()
	bob, mallory := newVisitor("Bob"), newVisitor("Mallory")
	acc := newAccess(bob).withRooms(room)
	s := liveKitService(8, acc)
	receiveWebhooks(t, s)

	inVoice := connect(t, joined(t, s, bob, room))
	waitForOccupancy(t, s, room, bob)

	// Mallory holds a token but has no access.
	removedOrRefused(t, joined(t, s, mallory, room))
	waitForParticipants(t, liveKitClient(), room, bob.ID)
	waitForOccupancy(t, s, room, bob)

	inVoice.room.Disconnect()
	waitForOccupancy(t, s, room)
}

func TestTheRefreshReadsLiveKitsListingAndRemovesWhoMayNotStay(t *testing.T) {
	room := ulid.Make().String()
	bob, mallory := newVisitor("Bob"), newVisitor("Mallory")
	acc := newAccess(bob).withRooms(room)
	s, lk := liveKitService(8, acc), liveKitClient()

	connect(t, joined(t, s, bob, room))
	connect(t, joined(t, s, mallory, room))
	waitForParticipants(t, lk, room, slices.Sorted(slices.Values([]string{bob.ID, mallory.ID}))...)
	if err := s.Refresh(t.Context()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if got := s.Occupancy(room); !slices.Equal(got, []identity.Visitor{bob}) {
		t.Errorf("occupancy = %+v, want Bob", got)
	}
	waitForParticipants(t, lk, room, bob.ID)
}
