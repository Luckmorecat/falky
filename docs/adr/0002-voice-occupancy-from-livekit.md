# Voice occupancy is owned by LiveKit; the server keeps only a view

Who is connected to a room's voice is never stored in the database. LiveKit is the source of truth; the server keeps an in-memory view, updated from signed LiveKit webhooks and refreshed from LiveKit's participant listing at startup and periodically, so missed webhooks heal instead of leaving ghost participants. Participants read occupancy of their own room directly from the LiveKit SDK; the server's view exists so visitors outside a room can see who is in it.

## Considered Options

- Persisting occupancy in SQLite: two sources of truth that drift after crashes and restarts.
- Clients reporting their own join/leave: lies after a crash or a lost connection.
- Polling only: simpler, but occupancy lags by the polling interval.
