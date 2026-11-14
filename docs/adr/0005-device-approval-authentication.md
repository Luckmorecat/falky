# Device approval records authentication separately from session access

An existing account session can explicitly approve another browser through a
sign-in link and code or a QR request. Session access remains independent of the
approver after completion, while authentication events retain the initial passkey
origin so removing that credential revokes every dependent session, including
approval chains whose original approver has logged out.

Device approval grants ordinary account access but never recent authentication
for sensitive changes. Only a successful passkey proof in the receiving session
can authorize credential management; a fresh approver must not confer that power
on another browser. Existing boolean fields remain for compatibility, with new
values false and historical true device flags ignored for authorization.
Transactional issuance and browser-bound encrypted cookie redelivery provide one
session with bounded delivery retries, rather than requiring exactly one HTTP
response. No operator-managed encryption key is added.

Migration 0013 resets account sessions instead of inventing missing historical
authentication evidence. It preserves guest sessions exactly because guests
cannot sign back into an existing identity. This extends the sign-in policy in
[ADR-0004](0004-passkey-accounts-with-guests.md); frontend approval interactions
remain separate work.

Frequent gated maintenance handles expiry, secret erasure and session revocation.
A separate startup/twelve-hour purge deletes sanitized inactive history in small
transactions outside the transport gate, so reclaiming storage does not delay
live access enforcement. Additive migration 0014 supplies lookup and maintenance
indexes without resetting sessions or rewriting authentication history again.
