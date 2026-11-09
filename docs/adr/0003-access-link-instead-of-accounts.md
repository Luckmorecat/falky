---
status: superseded by ADR-0004
---

# The first iteration has no accounts: one secret access link admits visitors

Historical decision; [ADR-0004](0004-passkey-accounts-with-guests.md) supersedes
the no-account model, universal link revocation and ownership consequence below.

Anyone holding the access link enters a name and is in; their browser remembers them as a visitor. This drops enrollment, passwords and sign-in from the first iteration so the work goes into rooms, chat and voice. The link is a shared password: whoever holds it reads every room's history, and replacing the link is the only way to remove anyone. Every request still resolves to a visitor at a single seam, so accounts can later be added behind it without touching chat or voice. LiveKit tokens are still minted only by the server, after that resolution.

## Consequences

- Messages from this iteration stay attributed to visitor names, not to accounts, after accounts arrive.
- A name is unique only among connected visitors, so an offline friend's name can be used by someone else.

## Parked for when accounts return

Decided earlier and set aside, not rejected: members enroll through single-use invites that expire after 7 days; admins act through the command line first and HTTP later; a removed member is disabled, never deleted, and keeps their messages. Guests, as a second kind of person beside members, were explored and superseded by visitors.
