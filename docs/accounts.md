# Accounts and guest access

The authoritative HTTP contract is [OpenAPI](../api/openapi.yaml). The backend
supports accounts; the current frontend still provides the existing guest flow.
Account invitation and recovery fragments are backend/client integration inputs,
not a claim that a registration UI exists. Operator commands are in the
[runbook](runbook.md#accounts-invitations-and-recovery).

## Identity and ownership

`identities.id` is the permanent opaque identity ID for guests and accounts.
`accounts.identity_id` extends that same identity. A successful invitation
enrollment upgrades a valid starting guest, preserving its messages, private
attachment drafts and colour. Without a valid guest cookie, an invitation alone
can start registration; a new identity is created only on verified completion.
Failure or cancellation creates no account and consumes no invitation.

An identity has zero or one account. Guests have an identity, an appearance-only
`profiles` row and a `sessions` row with `account_id=NULL`; they have no account
row. Registered sessions set `account_id=identity_id`, with a foreign key to
`accounts(identity_id)` and a constraint requiring both IDs to match. The
session kind is derived from that optional account reference. Every session
has an independent random ID and a separate random bearer token stored only
as its SHA-256 hash.

Registration adds the account and passkey, removes the old guest sessions and
issues a new account session, all in one transaction. The identity and profile
are retained. Multiple account sessions can reference the same account.
Guest-session validity follows the current shared-link generation and requires
that the identity still has no account. Account-session validity follows account
status and security generation. Both kinds require an unexpired deadline.

`profiles.identity_id` is its primary key and references `identities(id)`.
Profiles hold appearance, currently palette and revision; names remain in
`identities`, with account name reservations in `accounts.name_key`.
The HTTP contract retains its existing `Visitor` and `visitorId` field names.

Discoverable passkey sign-in selects an existing account and replaces the
browser session. It does not merge that browser's previous guest messages or
drafts. Two account browsers share the same permanent identity and ownership.
Message `author_name` remains the name at posting, including after rename,
upgrade, recovery or disablement.

Names retain trimmed, valid UTF-8, 1–32 rune validation, control/bidi-control
rejection and Unicode simple case-fold comparison. Accounts reserve names while
offline and disabled. Registration or account rename may claim a guest's name,
assigning all matching guests collision-free generated names. Another account's
name cannot be taken. Connected affected clients receive retryable live closure
and refresh `/api/me` on reconnect; occupancy publishes current names. Name
changes do not send `access.revoked` or rewrite message snapshots.

## Browser protocol

All account mutations require the exact configured `Origin`, including native
clients. POSTs require `application/json` containing one object, at most 64 KiB.
Account attempts have an independent per-client-IP burst of 20, refilling one
attempt every three seconds. Account responses use `no-store` and `no-cache`.
Invalid proofs receive generic errors without verifier details.

Begin returns `{id, expiresAt, options}`; `options` is the standard WebAuthn
`publicKey` creation or assertion envelope. Finish accepts
`{ceremonyId, credential, label?}`, where `credential` is the browser's standard
WebAuthn JSON with base64url binary fields, not a supplied public key or session.
Creation requests require user verification and discoverable resident keys,
including `credProps.rk=true`; assertion requires user verification. Verification
uses go-webauthn v0.18.2, configured RP ID/public-origin hostname and exact origin.
Keep the production hostname stable: changing it does not migrate passkeys to a
new RP. Cross-origin ceremonies are disabled.

Begin sets/reuses `__Host-falky-ceremony`, an opaque Secure, HttpOnly,
SameSite=Strict, Path=/ cookie with no Domain and a 600-second browser lifetime.
Finish requires the same cookie. Stored ceremonies expire absolutely after five
minutes and bind purpose, browser context and applicable account/session. Only
successful completion consumes them. Wrong context, challenge, purpose, owner,
signature, origin, RP, UV, expiry or replay fails.

| Operation | Request |
| --- | --- |
| Start invitation enrollment | `POST /api/accounts/registration/begin` with `{invitation, name}` |
| Complete enrollment | `POST /api/accounts/registration/finish` with finish input |
| Start discoverable sign-in | `POST /api/accounts/authentication/begin` with `{}` |
| Complete sign-in | `POST /api/accounts/authentication/finish` with finish input |
| Current identity/kind/expiry | `GET /api/accounts/session` |
| End this browser session | `POST /api/accounts/logout` with `{}` |
| Start/finish recent proof | `POST /api/accounts/reauthentication/begin` with `{}`, then `/finish` with finish input |
| List owner's passkeys | `GET /api/accounts/passkeys` |
| Start/finish another passkey | `POST /api/accounts/passkeys/begin` with `{}`, then `/finish` with finish input |
| Remove one passkey | `DELETE /api/accounts/passkeys/{credentialId}` |
| Replace recovery codes | `POST /api/accounts/recovery-codes` with `{}` |
| Start recovery enrollment | `POST /api/accounts/recovery/begin` with `{accountId, proof}` |
| Complete recovery | `POST /api/accounts/recovery/finish` with finish input |

For example, a client starts enrollment with the private invitation bearer and
retains response cookies:

```http
POST /api/accounts/registration/begin
Origin: https://falky.example
Content-Type: application/json

{"invitation":"<private bearer from operator>","name":"Alice"}
```

Pass `options.publicKey` to the appropriate browser WebAuthn operation after
decoding its binary fields. Complete with its signed credential response and
the same ceremony cookie. Enrollment returns `session` and ten `recoveryCodes`;
the browser also receives the opaque session cookie. Sign-in returns a session
without regenerating recovery codes. Keep all bearers and generation responses
out of URLs, logs and shared artifacts except the intended private fragment links.

## Sessions, passkeys and recovery

Both session kinds use the existing `falky_visitor` Secure, HttpOnly,
SameSite=Strict cookie at Path=/api. Server-side expiry is **90 days absolute
for accounts and 400 days absolute for guests**, without sliding renewal.
Cookie lifetimes match those deadlines. Logout revokes that session only.
Session resolution rejects expired, revoked, old-generation and disabled access
on API, attachments, live updates and RTC admission. Idle live and voice
connections close at the next maintenance pass after the session deadline (normally within 30 seconds). New requests and reconnects fail immediately at the authoritative database deadline; restarting never extends it.

An account can have several labeled passkeys. IDs identify individual credentials;
labels default to `Passkey` and are limited to 128 bytes. A credential belongs to
one account. Removing the last passkey is rejected transactionally. Adding or
removing a passkey and regenerating codes require verified passkey proof in that
same session within five minutes. Enrollment, sign-in and recovery establish
that proof; reauthentication refreshes it. Deleting the proving credential ends
its freshness, while normal previously issued sessions remain usable. Removing
one key does not perform recovery's all-session revocation.
The removed key can no longer sign in or establish fresh proof.

In `sessions`, `proof_at` is the Unix time of the most recent verified passkey
operation in that session; `proof_credential` is the credential ID used. The
pair is null for guests. They record neither private keys nor stored signatures.
Sensitive operations require a proof less than five minutes old, not in the
future, whose credential still belongs to the account. Reauthentication updates
only this pair and does not extend `expires_at`. These fields are scoped to a
browser session rather than the account, so verification in one browser never
refreshes another browser's permission. The credential reference is checked at
use rather than enforced with a deletion cascade: removing the proving passkey
invalidates recent proof while retaining normal access for an otherwise valid
session.

Each successful enrollment, recovery or authorized regeneration returns ten
high-entropy single-use recovery codes, plaintext only in that response.
Bearers use at least 256 bits of randomness and SHA-256 hashes at rest. Codes
have no independent time expiry, but regeneration and recovery invalidate the
old set. A code or operator grant authorizes replacement enrollment for one
account, not ordinary access. Recovery codes require the account ID; save
`session.visitor.id` alongside the codes in the recovery-code pack, rather than
the changeable name. Operator recovery links include that permanent ID.

Invitations expire after seven days. Operator recovery grants expire after
30 minutes. Beginning or failing recovery does not spend its proof or end any
access. Successful verified recovery atomically installs the replacement key,
invalidates all old passkeys, sessions, codes, recovery grants and account-bound
pending ceremonies, then issues a new 90-day session and fresh codes. The
permanent ID, reserved name, colour and history survive. Disabled accounts cannot
sign in or recover. No email, password or OAuth route exists.

## Live updates and voice

Main shares one lifecycle gate across HTTP/operator mutations, final live
registration, voice issuance and RTC admission. Successful mutation responses
await selective live/voice enforcement. Recovery preserves its new session while
ending all old access; logout affects one session; guest-link rotation affects
only guests. Absolute expiry is enforced on established idle live and voice connections by maintenance (normally within 30 seconds), and immediately on requests and reconnects. A
committed mutation finishes enforcement with an independent ten-second deadline,
even if its HTTP/operator caller disconnects. Cancellation before the identity
transaction commits still applies normally. A
postcommit enforcement failure returns an error; it does not roll back the
identity transaction or falsely report successful media removal. Grants are
already fenced and live access closed; inspect logs and restore LiveKit
connectivity before retrying repair/reconciliation.

`POST /api/rooms/{id}/voice` returns `{url, token, grantId}`. Every explicit Join,
for either session kind, creates a fresh durable grant and a never-reused transport,
even for the same session and room. Automatic SDK reconnect uses the existing exact
grant. Another account session gets `409 voice_transfer_required` until it sends
`{"confirmTransfer":true}`; unconfirmed attempts leave the first participant intact.
Account Join and Leave require exact configured Origin (`403 origin_forbidden`
otherwise), including nonbrowser clients. Guests retain omitted-body/no-Origin Join
behavior. Room-full refusal occurs before replacing the old grant. Confirmed
transfer fences the old grant and removes required old media before returning
replacement credentials; other chat sessions remain active. Failed required removal
returns an error without issuing new credentials, and remains retryable.

Newly issued voice tokens last ten minutes. A valid original or genuinely
LiveKit-refreshed JWT reconnects after backend restart for **both guests and
accounts**, only through its exact persisted active grant. The grant binds the
immutable session ID, permanent identity, kind, generation, room and transport.
Admission revalidates authoritative session expiry, account/guest policy and
room/name authorization. It never restores a missing or revoked grant from a JWT,
identity or session alone. JWT age, absent participants and disconnected sockets
do not revoke a valid grant. SDK Leave, reload, tab closure, temporary network loss
and failed connection setup are not intentional durable Leave.

Both kinds use signed immutable LiveKit transport identities
`<permanent ID>.<opaque grant nonce>`. SDK transport operations keep the full
identity; people, occupancy, tracks, cameras, screen shares, meters, speakers and
volume preferences use the permanent prefix before the dot. Metadata/attributes,
including deafened, are editable and never authorization inputs. Durable grants
are permission, not occupancy; LiveKit owns actual participation and media.

`POST /api/voice/leave` takes `{"grantId":"<exact transport>"}` under the owning
cookie session. It is idempotent and never resolves a stale target to a newer
grant. `200 {"revoked":true}` acknowledges durable revocation even if immediate
media cleanup failed; backend maintenance retains and retries that cleanup across
session deletion and restart. The browser stops local media immediately, persists
exact-grant pending intent before sending, retries after reload/reachability, and
shows pending server confirmation independently of any newer Join. Only durable
acknowledgement clears pending intent. A lost response or `401 visitor_required`
is not proof of revocation: the unresolved old target stays pending without
blocking new joins. Late Join credentials canceled by explicit Leave are queued
too; access ending or SDK disconnection does not create explicit Leave intent.

On the first upgrade to durable grants there is no safe backfill for historical
process-local permissions. Unknown participants/tokens are refused and removed;
each participant must explicitly rejoin voice once. Browser sessions and their
original deadlines survive the upgrade.

Both RTC entry points accept only GET `/rtc`, `/rtc/v1`, `/rtc/validate` and
`/rtc/v1/validate`. They verify JWT issuer/signature/strict expiry, room-join scope,
room and immutable current grant/session before forwarding to private LiveKit.
Stale/invalid access returns 403; an internal lookup failure returns 503.
Responses carry `X-Falky-RTC-Guard: 1` and `no-store`; management/API paths do not
proxy. The gate covers the first upstream Join/Reconnect response and socket
registration, then releases for streaming. Handshake/validation and normal
enforcement retain bounded operation deadlines. Failed setup closes only its
upstream socket and relies on LiveKit connection lifecycle, so an old handshake
cannot management-remove a replacement. Revocation is persisted first and all
affected local live/signalling sockets close before external media removal. Distinct transports prevent late old cleanup from removing
the new participant.

Both guest and account URLs always use the guarded public origin.
`FALKY_LIVEKIT_URL` cannot redirect returned credentials around the guard. Raw LiveKit signalling/API must remain private to the trusted application
network or development loopback. Exposing upstream 7880 bypasses admission.
See the runbook for packaged routing and the future rollout transition.
