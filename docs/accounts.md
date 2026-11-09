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
connections end at the session deadline as well.

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
only guests. Absolute expiry also ends idle live and voice connections. A
committed mutation finishes enforcement with an independent ten-second deadline,
even if its HTTP/operator caller disconnects. Cancellation before the identity
transaction commits still applies normally. A
postcommit enforcement failure returns an error; it does not roll back the
identity transaction or falsely report successful media removal. Grants are
already fenced and live access closed; inspect logs and restore LiveKit
connectivity before retrying repair/reconciliation.

`POST /api/rooms/{id}/voice` returns voice credentials. Another account session
gets `409 voice_transfer_required` until it sends `{"confirmTransfer":true}`;
unconfirmed attempts leave the first participant intact. Account voice requires
exact configured Origin (`403 origin_forbidden` otherwise), including nonbrowser
clients. Guests retain omitted-body/no-Origin behavior. Same owning session can
reconnect. Confirmed transfer fences old grants and removes old media before
returning replacement credentials; other chat sessions remain active.

Newly issued voice tokens last ten minutes; admission also requires a current
session/grant, so token expiry is not the revocation mechanism. An account's
signed immutable LiveKit transport identity is
`<permanent ID>.<opaque grant nonce>`. SDK consumers must map its prefix before
the dot to the permanent identity; guest transport IDs remain their permanent
IDs. Occupancy exposes permanent IDs. Metadata/attributes, including deafened,
are editable and never authorization inputs. Actual LiveKit-refreshed JWTs work
only while the bound session/generation/room grant remains current. Account
voice grants are process-local and fail closed: after a backend restart obtain fresh account
voice credentials; persistent accounts and sessions survive. Reconciliation
removes unknown account transports and unbound bare account participants.

Authorized guests may reconnect after a backend restart with a still-valid
original or LiveKit-refreshed JWT. The guard recovers only a unique persisted
guest session under the current guest-link generation, with no account record,
then revalidates that session and the room/name authorization under the same
lifecycle gate. Ambiguous guest-token state fails closed. Guest logout, link
rotation and account upgrade prevent restoration. A current issued-room choice
still fences earlier room tokens; restoration records its room in the new
process. No account or nonce-bearing transport uses this guest-only lookup.

Both RTC entry points accept only GET `/rtc`, `/rtc/v1`, `/rtc/validate` and
`/rtc/v1/validate`. They verify JWT issuer/signature/strict expiry, room-join scope,
room and immutable current grant/session before forwarding to private LiveKit.
Stale/invalid access returns 403; an internal lookup failure returns 503.
Responses carry `X-Falky-RTC-Guard: 1` and `no-store`; management/API paths do not
proxy. The gate covers the first upstream Join/Reconnect response and socket
registration, then releases for streaming. Handshake/validation and normal
enforcement are bounded at ten seconds; failed-handshake cleanup at two seconds.
Revocation fences first, awaits removal of the exact transport, then closes its
signalling sockets. Distinct transports prevent late old cleanup from removing
the new participant.

Account URLs always use the guarded public origin. `FALKY_LIVEKIT_URL` retains
legacy guest configuration; it cannot redirect account credentials around the
guard. Raw LiveKit signalling/API must remain private to the trusted application
network or development loopback. Exposing upstream 7880 bypasses admission.
See the runbook for packaged routing and the future rollout transition.
