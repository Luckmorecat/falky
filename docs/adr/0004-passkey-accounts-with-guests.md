# Passkey accounts share lasting visitor identities with guests

We now support invitation-only, passkey-only accounts alongside guests admitted
by the reusable access link, superseding [ADR-0003](0003-access-link-instead-of-accounts.md).
Upgrading a guest preserves its identity and ownership; signing into another
account switches identities without merging history. This retains shared-link
access while providing durable names and recoverable access without email,
passwords or an external identity service.

Account names remain reserved offline and when disabled. Accounts may displace
guest names but cannot take another account's name; historical message names
remain snapshots. Guest-link rotation affects guests only. Disablement retains
the account and its history; it cannot prevent someone with the shared link
from entering as a new guest.

Recovery enrolls a verified replacement passkey before atomically replacing old
credentials, sessions and recovery proofs. Public RTC admission shares the
session lifecycle with live updates: self-hosted LiveKit removal alone cannot
invalidate an already signed token. Distinct transport grants map to the lasting
identity; process-local grants fail closed after restart rather than extending
voice authorization independently of account state. The operational and API
contracts are recorded in [accounts](../accounts.md) and the [runbook](../runbook.md).
