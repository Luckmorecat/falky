# Passkey accounts share lasting identities with guests

Superseded by [ADR-0005](0005-password-accounts-behind-an-access-password.md): accounts now sign in with a login and password behind one access password, and guests are gone. The session, grant and enforcement model below still holds.

We now support invitation-only, passkey-only accounts alongside guests admitted
by the reusable access link, superseding [ADR-0003](0003-access-link-instead-of-accounts.md).
Upgrading a guest preserves its identity and ownership; signing into another
account switches identities without merging history. This retains shared-link
access while providing durable names and recoverable access without email,
passwords or an external identity service.

Guest and account access share one session model with independent IDs and
absolute server-side expiry: 400 days for guests, 90 for accounts. Account
membership is optional for an identity. Session kind follows its optional account
reference, while guest-link and account-security generations remain distinct
revocation policies. Appearance belongs to a profile and names to the identity.

Account names remain reserved offline and when disabled. Accounts may displace
guest names but cannot take another account's name; historical message names
remain snapshots. Guest-link rotation affects guests only. Disablement retains
the account and its history; it cannot prevent someone with the shared link
from entering as a new guest.

Recovery enrolls a verified replacement passkey before atomically replacing old
credentials, sessions and recovery proofs. Public RTC admission shares the
session lifecycle with live updates: self-hosted LiveKit removal alone cannot
invalidate an already signed token. Distinct transport grants map to the lasting
identity for guests and accounts. Exact grants are persisted independently of
occupancy and session deletion so valid original/refreshed JWTs reconnect during
the idle grace after restart and failed revocation cleanup remains retryable. Admission always
revalidates the original session deadline and current access policy; a missing
or revoked grant is never reconstructed from a token alone. Every explicit Join
creates a fresh independent transport without replacing any other grant, including
grants in the same session or room. This lets one person use separate audio and
screen-sharing connections without transferring ownership between browsers.
Leave disconnects only this app instance's local media. Its original grant can
reconnect before ten continuous minutes of confirmed absence, while JWT, session
and room access remain valid; actual successful reconnect cancels that countdown. Logout revokes all
grants of that exact session; recovery and disablement revoke all affected account
sessions.
Profiles remain owned by the lasting identity; media, participant presentation
and playback volume belong to each connection. After successful room admission,
the browser disconnects its previous local room without revoking permission.
Canceled or failed setup discards credentials and tears down captured local media;
unused grants receive ten minutes of grace from issuance. This retains bounded
valid-token reconnects without Leave revocation, browser retries or pending
notices. The idle lease is independent of JWT lifetime; existing participants
never expire merely from age. Security and access lifecycle changes retain
durable revocation.
The deprecated `confirmTransfer` request field is accepted and ignored for older
clients.
The first deployment of durable grants (`0010`) requires one explicit rejoin
because old process-local permissions cannot be safely backfilled. The independent
connection migration (`0011`) retains those persisted grants. Idle-grace migration
(`0012`) preserves unknown historical absence until a successful LiveKit listing
starts a full grace; known deadlines survive restart and refuse new admission at
the deadline, while destructive idle cleanup requires current confirmed absence. Maintenance closes
established expired access on its next pass, while new requests and reconnects
fail immediately.
The operational and API contracts are recorded in [OpenAPI](../../api/openapi.yaml)
and the [runbook](../runbook.md).
