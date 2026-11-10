# Falky

A private, self-hosted place for a small circle of friends to chat, talk by voice and share screens.

## People and access

**Access link**:
The reusable secret link that admits guests to this server. Replacing it ends guest access while accounts keep theirs.
_Avoid_: Account invitation, password

**Identity**:
A lasting identity that owns messages and attachments, whether a guest or an account. Becoming an account preserves that identity.
_Avoid_: Visitor, user, member

**Guest**:
An identity admitted through the access link and remembered by one browser. Entering afresh in another browser creates a different guest.

**Account**:
An identity with durable access established by accepting an account invitation and enrolling a passkey. The same account can use several browsers and keeps its name while away or disabled.

**Session**:
A browser's time-limited access to an identity, admitted as a guest or authenticated through an account. Several open tabs can share one session.

**Account invitation**:
A single-use invitation from the operator to become an account. It is separate from the shared access link.
_Avoid_: Access link, recovery link

**Recovery**:
Replacing an account's passkeys using a recovery code or an operator-issued recovery link. It preserves the account's identity, name and history while ending its previous access.

**Disabled account**:
An account whose access the operator has ended, with its identity, name and messages retained.

**Connected**:
Someone is connected while they have the app open. This is never shown to others.
_Avoid_: Online, present, active

**Name**:
What an identity is called, unique among connected identities. Accounts reserve their names even while away; a guest using a newly claimed account name receives another name.
_Avoid_: Handle, username, nickname

**Profile**:
An identity's visual appearance and personal decoration, separate from their name and access.

## Rooms and chat

**Room**:
A named place where people talk by voice and chat. Every room has both.
_Avoid_: Channel, voice channel, server, lobby

**Message**:
Text, attachments, or both that someone posts in a room's chat, shown under the name they had when posting.
_Avoid_: Post, chat line

**Attachment**:
A file someone shares with a message. Before posting, it is a private draft belonging to their identity.
_Avoid_: Upload, media

## Voice

**Voice grant**:
A session's permission for one independent voice connection in one room, retained during participation and for ten minutes of continuous confirmed absence or nonuse, unless access expires or is revoked sooner. A session can hold several independent grants for the same or different rooms.

**Participant**:
One connection of an identity currently in a room's voice. The same identity can have several participants in the same or different rooms.
_Avoid_: Voice member, attendee

**Occupancy**:
The set of participants of a room at a given moment.
_Avoid_: Presence, voice members, roster

**Muted**:
A participant whose microphone is not heard by others.

**Deafened**:
A participant who hears no one and is also muted.

**Camera**:
A participant's camera picture, shown on their orb to the other participants of the same room.
_Avoid_: Video, webcam

**Screen share**:
A participant's screen, shown to the other participants of the same room.
_Avoid_: Stream, broadcast, screencast
