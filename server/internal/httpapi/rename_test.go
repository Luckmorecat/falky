package httpapi

import (
	"errors"
	"net/http"
	"testing"

	"github.com/coder/websocket"
	"github.com/kisshot/falky/server/internal/api"
	"github.com/kisshot/falky/server/internal/identity/passkeytest"
)

func TestOrdinaryRenameSucceedsAndRefreshesEveryOwnerTabDuringVoiceOutage(t *testing.T) {
	for _, kind := range []string{"guest", "account"} {
		t.Run(kind, func(t *testing.T) {
			p := startPublic(t, 100)
			client, browser := p.browserWithHTTP(t)
			if kind == "account" {
				enrollAccount(t, p, browser, "Before", passkeytest.New(t))
			} else {
				p.enter(t, client, "Before")
			}
			first, second := p.connectLive(t, browser), p.connectLive(t, browser)
			watcher, watcherHTTP := p.browserWithHTTP(t)
			p.enter(t, watcher, "Watcher")
			unrelated := p.connectLive(t, watcherHTTP)
			p.livekit.Fail(errors.New("LiveKit unavailable"))

			renamed, err := client.RenameMeWithResponse(t.Context(), api.RenameRequest{Name: "After"})
			if err != nil || renamed.StatusCode() != http.StatusOK || renamed.JSON200 == nil || renamed.JSON200.Name != "After" {
				t.Fatalf("rename during voice outage = %+v, %v; want 200 with committed name", renamed, err)
			}
			readClosed(t, first, websocket.StatusGoingAway)
			readClosed(t, second, websocket.StatusGoingAway)
			me, err := client.GetMeWithResponse(t.Context())
			if err != nil || me.JSON200 == nil || me.JSON200.Name != "After" {
				t.Fatalf("persisted name = %+v, %v", me, err)
			}
			p.connectLive(t, browser)
			p.createRoom(t, "Text remains available")
			if event := nextEvent(t, unrelated); event.Type != api.EventTypeRoomChanged {
				t.Fatalf("unrelated session lost live updates: %+v", event)
			}
		})
	}
}

func TestRenameStillReportsRequiredLifecycleFailureDuringVoiceOutage(t *testing.T) {
	p := startPublic(t, 100)
	account, browser := p.browserWithHTTP(t)
	enrollAccount(t, p, browser, "Account", passkeytest.New(t))
	guest, guestHTTP := p.browserWithHTTP(t)
	p.enter(t, guest, "Claimed")
	displaced := p.connectLive(t, guestHTTP)
	p.livekit.Fail(errors.New("LiveKit unavailable"))

	renamed, err := account.RenameMeWithResponse(t.Context(), api.RenameRequest{Name: "Claimed"})
	if err != nil || renamed.StatusCode() != http.StatusInternalServerError {
		t.Fatalf("required lifecycle failure = %+v, %v; want 500", renamed, err)
	}
	readClosed(t, displaced, websocket.StatusGoingAway)
	current, err := guest.GetMeWithResponse(t.Context())
	if err != nil || current.JSON200 == nil || current.JSON200.Name == "Claimed" {
		t.Fatalf("committed guest displacement lost: %+v, %v", current, err)
	}
}
