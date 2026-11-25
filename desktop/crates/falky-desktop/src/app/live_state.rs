use std::collections::BTreeMap;

use falky_core::model::{
    AccountSession, LivePayload, LiveScope, LiveUpdate, PaletteName, ReconnectSnapshot, Room,
    SessionScope, Visitor, VisitorColour, VisitorId,
};

pub(super) struct LiveState {
    pub scope: SessionScope,
    pub account: AccountSession,
    pub rooms: Vec<Room>,
    pub colours: BTreeMap<VisitorId, VisitorColour>,
    pub reconnecting: bool,
    active: Option<LiveScope>,
    last_generation: Option<u64>,
    snapshot_ready: bool,
    profile_version: u64,
    profile_at_connect: u64,
}

impl LiveState {
    pub fn new(scope: SessionScope, account: AccountSession) -> Self {
        Self {
            scope,
            colours: [(account.visitor.id.clone(), account.visitor.colour.clone())].into(),
            account,
            rooms: Vec::new(),
            reconnecting: false,
            active: None,
            last_generation: None,
            snapshot_ready: false,
            profile_version: 0,
            profile_at_connect: 0,
        }
    }

    pub fn begin(&mut self, scope: LiveScope) -> bool {
        let generation = scope.generation.0;
        if scope.session != self.scope
            || self.last_generation.is_some_and(|last| generation <= last)
        {
            return false;
        }
        self.active = Some(scope);
        self.last_generation = Some(generation);
        self.snapshot_ready = false;
        self.profile_at_connect = self.profile_version;
        true
    }

    pub fn connected_scope(&self) -> Option<&LiveScope> {
        self.active.as_ref().filter(|_| self.snapshot_ready)
    }

    pub fn lose(&mut self) {
        self.active = None;
        self.snapshot_ready = false;
        self.reconnecting = true;
    }

    pub fn install(&mut self, mut snapshot: ReconnectSnapshot) -> bool {
        if self.active.as_ref() != Some(&snapshot.scope) || self.snapshot_ready {
            return false;
        }
        self.merge_colour(snapshot.session.visitor.colour.clone());
        for assignment in snapshot.colours {
            self.merge_colour(assignment);
        }
        // A rename may have completed while this snapshot was in flight.
        if self.profile_at_connect != self.profile_version {
            snapshot.session.visitor.name = self.account.visitor.name.clone();
            snapshot.session.visitor.name_taken = self.account.visitor.name_taken;
        }
        snapshot.session.visitor.colour = self.account.visitor.colour.clone();
        self.account = snapshot.session;
        self.rooms = snapshot.rooms;
        self.snapshot_ready = true;
        self.reconnecting = false;
        true
    }

    pub fn apply(&mut self, update: &LiveUpdate) -> bool {
        if self.connected_scope() != Some(&update.scope) {
            return false;
        }
        match &update.event.payload {
            LivePayload::RoomChanged(change) => {
                if let Some(room) = self.rooms.iter_mut().find(|room| room.id == change.id) {
                    room.name.clone_from(&change.name);
                } else {
                    self.rooms.push(Room {
                        id: change.id.clone(),
                        name: change.name.clone(),
                        occupancy: Vec::new(),
                    });
                }
            }
            LivePayload::OccupancyChanged(change) => {
                if let Some(room) = self.rooms.iter_mut().find(|room| room.id == change.room_id) {
                    room.occupancy.clone_from(&change.occupancy);
                }
            }
            LivePayload::VisitorColourChanged(assignment) => self.merge_colour(assignment.clone()),
            _ => {}
        }
        true
    }

    pub fn rename(&mut self, mut visitor: Visitor) {
        self.merge_colour(visitor.colour);
        visitor.colour = self.account.visitor.colour.clone();
        self.account.visitor = visitor;
        self.profile_version += 1;
    }

    pub fn merge_colour(&mut self, assignment: VisitorColour) {
        if self
            .colours
            .get(&assignment.visitor_id)
            .is_some_and(|stored| stored.revision >= assignment.revision)
        {
            return;
        }
        if assignment.visitor_id == self.account.visitor.id {
            self.account.visitor.colour = assignment.clone();
        }
        self.colours
            .insert(assignment.visitor_id.clone(), assignment);
    }

    pub fn palette(&self, visitor: &VisitorId) -> Option<PaletteName> {
        self.colours
            .get(visitor)
            .map(|assignment| assignment.palette)
    }
}

#[cfg(test)]
mod tests;
