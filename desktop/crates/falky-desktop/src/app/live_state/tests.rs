use falky_core::{
    Origin,
    model::{
        LiveEvent, OccupancyChange, Participant, ReconnectGeneration, RoomChange,
        SessionGeneration, SessionKind,
    },
};

use super::*;

fn session() -> SessionScope {
    SessionScope {
        origin: Origin::parse("https://example.com").unwrap(),
        generation: SessionGeneration(1),
    }
}

fn account(name: &str, revision: i64) -> AccountSession {
    AccountSession {
        visitor: Visitor {
            id: "self".into(),
            name: name.into(),
            name_taken: false,
            colour: VisitorColour {
                visitor_id: "self".into(),
                palette: PaletteName::Sky,
                revision,
            },
        },
        kind: SessionKind::Account,
        expires_at: None,
    }
}

fn socket(session: &SessionScope, generation: u64) -> LiveScope {
    LiveScope {
        session: session.clone(),
        generation: ReconnectGeneration(generation),
    }
}

fn snapshot(scope: &LiveScope, account: AccountSession) -> ReconnectSnapshot {
    ReconnectSnapshot {
        scope: scope.clone(),
        session: account,
        rooms: vec![Room {
            id: "lobby".into(),
            name: "Lobby".into(),
            occupancy: Vec::new(),
        }],
        colours: Vec::new(),
    }
}

fn event(scope: &LiveScope, payload: LivePayload) -> LiveUpdate {
    LiveUpdate {
        scope: scope.clone(),
        event: LiveEvent {
            v: 1,
            event_id: "1".into(),
            room_id: Some("lobby".into()),
            timestamp: chrono::Utc::now(),
            payload,
        },
    }
}

#[test]
fn waits_for_a_current_snapshot_and_keeps_rooms_during_reconnect() {
    let session = session();
    let mut state = LiveState::new(session.clone(), account("A", 1));
    let first = socket(&session, 1);
    let second = socket(&session, 2);
    let occupancy = event(
        &first,
        LivePayload::OccupancyChanged(OccupancyChange {
            room_id: "lobby".into(),
            occupancy: vec![Participant {
                connection_id: "connected".into(),
                visitor_id: "someone".into(),
                name: "Someone".into(),
            }],
        }),
    );

    assert!(state.begin(first.clone()));
    assert!(!state.apply(&occupancy));
    assert!(state.install(snapshot(&first, account("A", 1))));
    assert!(state.apply(&occupancy));
    assert_eq!(state.rooms[0].occupancy.len(), 1);
    state.lose();
    assert!(state.reconnecting);
    assert_eq!(state.rooms[0].occupancy.len(), 1);
    assert!(!state.apply(&occupancy));
    assert!(!state.install(snapshot(&first, account("A", 1))));
    assert!(state.begin(second.clone()));
    assert!(!state.begin(first));
    assert!(!state.apply(&occupancy));
    assert!(state.install(snapshot(&second, account("A", 1))));
    assert!(!state.reconnecting);
    assert!(state.rooms[0].occupancy.is_empty());

    let changed = event(
        &second,
        LivePayload::RoomChanged(RoomChange {
            id: "lobby".into(),
            name: "Lounge".into(),
        }),
    );
    assert!(state.apply(&changed));
    assert_eq!(state.rooms[0].name, "Lounge");
}

#[test]
fn stale_snapshot_cannot_overwrite_newer_profile_or_colours() {
    let session = session();
    let mut state = LiveState::new(session.clone(), account("Old name", 1));
    let socket = socket(&session, 1);
    assert!(state.begin(socket.clone()));

    let mut renamed = account("New name", 1).visitor;
    renamed.name_taken = true;
    state.rename(renamed);
    state.merge_colour(VisitorColour {
        visitor_id: "self".into(),
        palette: PaletteName::Ruby,
        revision: 3,
    });
    let mut snapshot = snapshot(&socket, account("Old name", 2));
    snapshot.colours.push(VisitorColour {
        visitor_id: "other".into(),
        palette: PaletteName::Moss,
        revision: 7,
    });
    assert!(state.install(snapshot));

    let event = event(
        &socket,
        LivePayload::VisitorColourChanged(VisitorColour {
            visitor_id: "other".into(),
            palette: PaletteName::Plum,
            revision: 6,
        }),
    );
    assert!(state.apply(&event));
    assert_eq!(state.account.visitor.name, "New name");
    assert!(state.account.visitor.name_taken);
    assert_eq!(state.account.visitor.colour.palette, PaletteName::Ruby);
    assert_eq!(state.palette(&"other".into()), Some(PaletteName::Moss));
}

#[test]
fn prior_login_socket_cannot_install_a_snapshot() {
    let session = session();
    let old_socket = socket(&session, 1);
    let mut next_session = session;
    next_session.generation = SessionGeneration(2);
    let mut state = LiveState::new(next_session, account("A", 1));

    assert!(!state.begin(old_socket.clone()));
    assert!(!state.install(snapshot(&old_socket, account("A", 1))));
    assert!(state.rooms.is_empty());
}
