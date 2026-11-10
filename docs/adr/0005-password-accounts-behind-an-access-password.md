# Password accounts behind one access password

Everyone signs in with a login and a password, after their browser has once given the server's shared access password. This supersedes [ADR-0004](0004-passkey-accounts-with-guests.md): passkeys, single-use invitations, guests and the reusable guest link are gone. The circle wanted the familiar login-and-password flow, and one shared password the owner can change replaces both the guest link and per-person invitations.

The access password is set by the operator (`falky password set`) and stored as an Argon2id hash. Giving it sets a 400-day pass cookie that signing in, registering and recovering require; changing it ends every pass but no signed-in session. Account passwords are Argon2id hashes with their parameters in the stored string, so the cost can change without locking anyone out. An unknown login and a wrong password are refused alike, and attempts are limited per address and per login. Logins are private and permanent until recovery; the name others see stays separate and changeable, and is unique among accounts.

Sessions, voice grants, revocation effects and live enforcement keep ADR-0004's model unchanged: 90-day absolute account sessions, durable grants, and enforcement under the lifecycle gate. Changing a password ends every other session of the account. Without email there is no self-service reset: the operator issues a one-time, 30-minute recovery code (`falky account recover`) after verifying the person, and using it sets a new password and ends every old session. The twelve-word recovery phrase from ADR-0004 was dropped as a needless step at registration for a circle where the operator knows everyone.

Any account may create and rename rooms, up to 50 rooms and a few changes a minute each; deleting stays with the operator, because a room's chat and attachments go with it.

## Consequences

- Guest sessions no longer admit anything. A browser that still holds one may register without the access password, and the account keeps that guest's identity, colour and history.
- Passkey accounts keep their identity, name and history but have no login or password until the operator issues them a recovery code; recovering sets both.
- A shared access password can leak; changing it stops new sign-ins and registrations by whoever has the old one, but excluding a person still takes `falky account disable`.
