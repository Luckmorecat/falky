# Falky

A private, self-hosted place for a small circle of friends to chat, talk by voice and share screens.

## People and access

**Access password**:
The one shared password that lets a browser sign in or register on this server. The operator sets and changes it (`falky password set`); changing it makes every browser give it again but signs no one out.
_Avoid_: Access link, invite, server password, room password

**Identity**:
A lasting identity that owns messages and attachments. An account keeps its identity through recovery, and from the guest it may have been.
_Avoid_: Visitor, user, member

**Account**:
An identity someone signs in to with a login and a password. The same account can use several browsers and keeps its name while away or disabled.

**Login**:
What an account signs in with: private, never shown to others, and separate from its name.
_Avoid_: Username, handle

**Session**:
A browser's time-limited access to an account, started by registering, signing in or recovering. Several open tabs can share one session.

**Recovery**:
Setting a new password with a one-time recovery code the operator issues. It preserves the account's identity, name and history while ending its previous sessions.
_Avoid_: Recovery phrase, password reset email

**Disabled account**:
An account whose access the operator has ended, with its identity, name and messages retained.

**Connected**:
Someone is connected while they have the app open. This is never shown to others.
_Avoid_: Online, present, active

**Name**:
What others see an account called, unique among accounts, and kept even while the account is away or disabled.
_Avoid_: Handle, username, nickname, login

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
