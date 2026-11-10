# Voice occupancy is owned by LiveKit; the server keeps only a view

Who is connected to a room's voice is never stored in the database. LiveKit is the source of truth; the server keeps an in-memory view, updated from signed LiveKit webhooks and refreshed from LiveKit's participant listing at startup and periodically, so missed webhooks heal instead of leaving ghost participants. Participants read occupancy of their own room directly from the LiveKit SDK; the server's view exists so visitors outside a room can see who is in it.

Durable voice grants are stored separately as authorization and pending cleanup
work. An authorized grant does not imply a participant is connected. Each grant
has a durable nullable absence timestamp: new grants start their ten-minute grace
at issuance; actual successful guarded admission and authoritative presence clear
it. A successful full participant listing starts absence for a previously active
or pre-upgrade unknown grant, then fences it after ten continuous absent minutes.
A failed listing is unknown and cannot authorize idle cleanup. Known deadlines
survive restart and refuse new admission immediately at the deadline; destructive
cleanup waits for current authoritative absence. Existing participants survive
old deadlines when a fresh listing confirms their presence. Each explicit Join
receives an independent, never-reused transport target, even within the same session. The view lists every
connection separately with its stable `connectionId`, permanent `visitorId` and
current name; reconnect SID changes do not change connection identity. Events
remain SID-scoped so a late departure cannot remove a reconnected participant.
Room capacity and occupancy count connections, including several of one identity.

Webhooks update only occupancy; delayed SID events cannot change authorization
leases. Listing snapshots carry transient revisions, and an actual bounded
handshake reserves its grant atomically before the idle deadline. Successful
upstream admission durably clears absence before returning success. A failed
attempt retains the previous deadline. This keeps polling and admission race-safe
without making polling wait for the lifecycle gate or storing occupancy in SQLite.
Lease metadata is authorization state, distinct from the ten-minute JWT lifetime.
Reconciliation and cleanup run through the internal maintenance job at startup
and every 30 seconds.

## Considered Options

- Persisting occupancy in SQLite: two sources of truth that drift after crashes and restarts.
- Clients reporting their own join/leave: lies after a crash or a lost connection.
- Polling only: simpler, but occupancy lags by the polling interval.
