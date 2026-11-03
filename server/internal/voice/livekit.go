package voice

import (
	"context"
	"errors"
	"fmt"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/twitchtv/twirp"
)

// Client is a voice.LiveKit backed by a real LiveKit server's API.
type Client struct {
	rooms *lksdk.RoomServiceClient
}

var _ LiveKit = (*Client)(nil)

// NewClient returns the client of the LiveKit server whose API is at apiURL,
// authenticating with apiKey and apiSecret.
func NewClient(apiURL, apiKey, apiSecret string) *Client {
	return &Client{rooms: lksdk.NewRoomServiceClient(apiURL, apiKey, apiSecret)}
}

// Participants lists the participants of every room LiveKit has open.
func (c *Client) Participants(ctx context.Context) ([]Participant, error) {
	rooms, err := c.rooms.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return nil, fmt.Errorf("list rooms: %w", err)
	}
	var participants []Participant
	for _, room := range rooms.GetRooms() {
		res, err := c.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room.GetName()})
		if err != nil {
			return nil, fmt.Errorf("list participants of room %s: %w", room.GetName(), err)
		}
		for _, p := range res.GetParticipants() {
			participants = append(participants, Participant{Room: room.GetName(), Identity: p.GetIdentity()})
		}
	}
	return participants, nil
}

// RemoveParticipant disconnects the participant identity from room; LiveKit
// answering that there is no such participant counts as success.
func (c *Client) RemoveParticipant(ctx context.Context, room, identity string) error {
	_, err := c.rooms.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: room, Identity: identity})
	if terr, ok := errors.AsType[twirp.Error](err); ok && terr.Code() == twirp.NotFound {
		return nil
	}
	return err
}
