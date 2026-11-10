# Device approval records authentication separately from session access

An existing account session can explicitly approve another browser through a
sign-in link and code or a QR request. Session access remains independent of the
approver after completion, while authentication events retain the initial passkey
origin so removing that credential revokes every dependent session, including
approval chains whose original approver has logged out.

Device approval carries recent authentication only when its approver's latest
event is a fresh actual passkey proof. This permits ordinary sign-in from older
sessions without allowing approval chains to bypass sensitive-action protection.
Transactional issuance and browser-bound encrypted cookie redelivery provide one
session with bounded delivery retries, rather than requiring exactly one HTTP
response. No operator-managed encryption key is added.

Migration 0013 resets account sessions instead of inventing missing historical
authentication evidence. It preserves guest sessions exactly because guests
cannot sign back into an existing identity. This extends the sign-in policy in
[ADR-0004](0004-passkey-accounts-with-guests.md); frontend approval interactions
remain separate work.
