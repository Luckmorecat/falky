use crate::model::ConnectionId;
use std::collections::BTreeSet;

#[derive(Default)]
pub(super) struct WatchPolicy {
    remote: BTreeSet<ConnectionId>,
    local: Option<ConnectionId>,
    watched: Option<ConnectionId>,
    dismissed: bool,
}

impl WatchPolicy {
    pub fn update(&mut self, remote: BTreeSet<ConnectionId>, local: Option<ConnectionId>) -> bool {
        let started = remote.difference(&self.remote).next().is_some();
        self.remote = remote;
        self.update_local(local);
        started
    }

    pub fn update_local(&mut self, local: Option<ConnectionId>) {
        self.local = local;
        if self.remote.is_empty() && self.local.is_none() {
            self.dismissed = false;
        }
        if !self.dismissed && self.watched.as_ref().is_none_or(|id| !self.contains(id)) {
            self.watched = self.remote.first().or(self.local.as_ref()).cloned();
        }
    }

    pub fn watch(&mut self, id: ConnectionId) {
        if self.contains(&id) {
            self.dismissed = false;
            self.watched = Some(id);
        }
    }

    pub fn dismiss(&mut self) {
        if self.watched.take().is_some() {
            self.dismissed = true;
        }
    }

    pub fn target(&self) -> Option<&ConnectionId> {
        self.watched.as_ref()
    }

    pub fn remote_target(&self) -> Option<&ConnectionId> {
        self.watched.as_ref().filter(|id| self.remote.contains(*id))
    }

    pub fn local_selected(&self) -> bool {
        self.watched.is_some() && self.watched == self.local
    }

    fn contains(&self, id: &ConnectionId) -> bool {
        self.remote.contains(id) || self.local.as_ref() == Some(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: &str) -> ConnectionId {
        ConnectionId::from(value)
    }

    fn remotes(ids: &[&str]) -> BTreeSet<ConnectionId> {
        ids.iter().map(|value| id(value)).collect()
    }

    #[test]
    fn selects_first_auto_switches_and_only_cues_new_remote_sharers() {
        let mut policy = WatchPolicy::default();
        assert!(policy.update(remotes(&["b"]), None));
        assert_eq!(policy.remote_target(), Some(&id("b")));
        assert!(policy.update(remotes(&["a", "b"]), Some(id("me"))));
        assert_eq!(policy.remote_target(), Some(&id("b")));
        assert!(!policy.update(remotes(&["a"]), Some(id("me"))));
        assert_eq!(policy.remote_target(), Some(&id("a")));
        policy.watch(id("me"));
        assert!(policy.local_selected());
        assert!(policy.remote_target().is_none());
        assert!(!policy.update(remotes(&["a"]), None));
        assert_eq!(policy.remote_target(), Some(&id("a")));
    }

    #[test]
    fn dismissal_survives_new_shares_and_resets_when_everyone_stops() {
        let mut policy = WatchPolicy::default();
        policy.update(remotes(&["a"]), Some(id("me")));
        policy.dismiss();
        policy.update(remotes(&["c"]), Some(id("me")));
        policy.update(remotes(&[]), Some(id("me")));
        assert_eq!(policy.target(), None);
        policy.watch(id("c"));
        assert_eq!(policy.target(), None);
        policy.watch(id("me"));
        assert!(policy.local_selected());
        policy.dismiss();
        policy.update(remotes(&[]), None);
        assert!(policy.update(remotes(&["b"]), None));
        assert_eq!(policy.remote_target(), Some(&id("b")));
    }

    #[test]
    fn reconnect_replaced_publications_keep_the_shared_connection_baseline() {
        let mut policy = WatchPolicy::default();
        policy.update(remotes(&["a"]), None);
        policy.dismiss();
        assert!(!policy.update(remotes(&["a"]), None));
        assert_eq!(policy.target(), None);
    }
}
