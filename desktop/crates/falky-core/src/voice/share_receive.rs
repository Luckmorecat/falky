use super::{ShareFrame, share_policy::WatchPolicy};
use crate::{
    audio::{BLOCK_LEN, Mix, RATE, StereoBlock},
    model::ConnectionId,
};
use futures_util::{FutureExt, StreamExt};
use livekit::{
    prelude::{
        RemoteTrack, RemoteTrackPublication, Room, RoomEvent, TrackKind, TrackPublication,
        TrackSid, TrackSource,
    },
    webrtc::{
        audio_stream::native::{NativeAudioStream, NativeAudioStreamOptions},
        video_stream::native::{NativeVideoStream, NativeVideoStreamOptions},
    },
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub(super) struct ShareFrames(Arc<Mutex<Option<DisplayedFrame>>>);

struct DisplayedFrame {
    connection: ConnectionId,
    frame: Arc<ShareFrame>,
}

impl ShareFrames {
    pub fn get(&self, id: &ConnectionId) -> Option<Arc<ShareFrame>> {
        self.0
            .lock()
            .expect("screen frame lock")
            .as_ref()
            .filter(|current| &current.connection == id)
            .map(|current| current.frame.clone())
    }

    pub fn set(&self, id: &ConnectionId, frame: Arc<ShareFrame>) {
        *self.0.lock().expect("screen frame lock") = Some(DisplayedFrame {
            connection: id.clone(),
            frame,
        });
    }

    pub fn clear(&self) {
        *self.0.lock().expect("screen frame lock") = None;
    }
}

#[derive(PartialEq, Eq)]
enum Source {
    Video,
    Audio,
}

fn source(source: TrackSource, kind: TrackKind) -> Option<Source> {
    match (source, kind) {
        (TrackSource::Screenshare, TrackKind::Video) => Some(Source::Video),
        (TrackSource::ScreenshareAudio, TrackKind::Audio) => Some(Source::Audio),
        _ => None,
    }
}

pub(super) fn screen_source(source: TrackSource, kind: TrackKind) -> bool {
    self::source(source, kind).is_some()
}

struct Publication {
    connection: ConnectionId,
    track: RemoteTrackPublication,
}

impl Publication {
    fn sid(&self) -> TrackSid {
        self.track.sid()
    }

    fn source(&self) -> Option<Source> {
        source(self.track.source(), self.track.kind())
    }
}

#[derive(Default)]
struct ScreenCatalog(BTreeMap<TrackSid, (ConnectionId, bool)>);

impl ScreenCatalog {
    fn published(&mut self, sid: TrackSid, connection: ConnectionId, active: bool) {
        self.0.insert(sid, (connection, active));
    }

    fn set_active(&mut self, sid: &TrackSid, active: bool) {
        if let Some((_, current)) = self.0.get_mut(sid) {
            *current = active;
        }
    }

    fn active(&self, sid: &TrackSid) -> bool {
        self.0.get(sid).is_some_and(|(_, active)| *active)
    }

    fn active_sharers(&self) -> BTreeSet<ConnectionId> {
        self.0
            .values()
            .filter(|(_, active)| *active)
            .map(|(connection, _)| connection.clone())
            .collect()
    }
}

#[derive(Default)]
pub(super) struct ShareReceiver {
    catalog: ScreenCatalog,
    policy: WatchPolicy,
    video: Option<Received<NativeVideoStream>>,
    audio: Option<Received<NativeAudioStream>>,
}

struct Received<T> {
    sid: TrackSid,
    rtc_id: String,
    publication: RemoteTrackPublication,
    stream: T,
}

impl<T> Received<T> {
    fn matches(&self, publication: &Publication, rtc_id: &str) -> bool {
        self.sid == publication.sid() && self.rtc_id == rtc_id
    }
}

#[derive(Default)]
struct Desired<'a, T> {
    video: Option<&'a T>,
    audio: Option<&'a T>,
}

fn desired<'a, T>(
    visible: bool,
    candidates: impl Iterator<Item = (&'a T, Option<Source>)>,
) -> Desired<'a, T> {
    let mut desired = Desired {
        video: None,
        audio: None,
    };
    for (value, source) in candidates {
        match source {
            Some(Source::Video) if visible && desired.video.is_none() => {
                desired.video = Some(value)
            }
            Some(Source::Audio) if desired.audio.is_none() => desired.audio = Some(value),
            _ => {}
        }
    }
    desired
}

impl ShareReceiver {
    pub fn target(&self) -> Option<&ConnectionId> {
        self.policy.target()
    }

    pub fn change_target(
        &mut self,
        expected: Option<&ConnectionId>,
        target: Option<ConnectionId>,
    ) -> bool {
        if self.policy.target() != expected {
            return false;
        }
        if let Some(target) = target {
            self.policy.watch(target);
        } else {
            self.policy.dismiss();
        }
        self.policy.target() != expected
    }

    pub fn update_local(&mut self, local: Option<ConnectionId>) {
        self.policy.update_local(local);
    }

    pub fn suspend(&mut self, frames: &ShareFrames) {
        self.video = None;
        self.audio = None;
        if !self.policy.local_selected() {
            frames.clear();
        }
    }

    pub fn event(&mut self, event: &RoomEvent) -> bool {
        match event {
            RoomEvent::Connected {
                participants_with_tracks,
            } => {
                for (participant, tracks) in participants_with_tracks {
                    for track in tracks {
                        if source(track.source(), track.kind()) == Some(Source::Video) {
                            self.catalog.published(
                                track.sid(),
                                ConnectionId::from(participant.identity().as_str()),
                                !track.is_muted(),
                            );
                        }
                    }
                }
            }
            RoomEvent::TrackPublished {
                participant,
                publication,
            } if screen_source(publication.source(), publication.kind()) => {
                if source(publication.source(), publication.kind()) == Some(Source::Video) {
                    self.catalog.published(
                        publication.sid(),
                        ConnectionId::from(participant.identity().as_str()),
                        !publication.is_muted(),
                    );
                }
            }
            RoomEvent::TrackUnpublished { publication, .. }
                if screen_source(publication.source(), publication.kind()) =>
            {
                self.catalog.0.remove(&publication.sid());
            }
            RoomEvent::ParticipantDisconnected(participant) => {
                self.catalog.0.retain(|_, (connection, _)| {
                    connection.as_str() != participant.identity().as_str()
                });
            }
            RoomEvent::TrackMuted {
                publication: TrackPublication::Remote(track),
                ..
            }
            | RoomEvent::TrackUnmuted {
                publication: TrackPublication::Remote(track),
                ..
            } if source(track.source(), track.kind()) == Some(Source::Video) => {
                self.catalog.set_active(
                    &track.sid(),
                    matches!(event, RoomEvent::TrackUnmuted { .. }),
                );
            }
            RoomEvent::TrackSubscribed { publication, .. }
            | RoomEvent::TrackUnsubscribed { publication, .. }
                if screen_source(publication.source(), publication.kind()) => {}
            _ => return false,
        }
        true
    }

    pub fn reconcile(
        &mut self,
        room: &Room,
        frames: &ShareFrames,
        local: Option<ConnectionId>,
        visible: bool,
    ) -> bool {
        let publications = room
            .remote_participants()
            .into_values()
            .flat_map(|participant| {
                let connection = ConnectionId::from(participant.identity().as_str());
                participant
                    .track_publications()
                    .into_values()
                    .map(move |track| Publication {
                        connection: connection.clone(),
                        track,
                    })
            });
        let mut tracks: Vec<_> = publications
            .filter(|publication| publication.source().is_some())
            .collect();
        tracks.sort_by_key(Publication::sid);
        let started = self.policy.update(self.catalog.active_sharers(), local);

        let selected = tracks
            .iter()
            .filter(|publication| self.policy.remote_target() == Some(&publication.connection))
            .filter(|publication| {
                publication.source() != Some(Source::Video)
                    || (self.catalog.active(&publication.sid()) && !publication.track.is_muted())
            });
        let desired = desired(
            visible,
            selected.map(|publication| (publication, publication.source())),
        );
        let requested_video = desired.video.map(Publication::sid);
        let requested_audio = desired.audio.map(Publication::sid);
        for publication in &tracks {
            let sid = publication.sid();
            if Some(&sid) != requested_video.as_ref()
                && Some(&sid) != requested_audio.as_ref()
                && (publication.track.is_desired() || publication.track.is_subscribed())
            {
                publication.track.set_subscribed(false);
            }
        }

        self.sync_video(frames, desired.video);
        self.sync_audio(desired.audio);
        started
    }

    fn sync_video(&mut self, frames: &ShareFrames, desired: Option<&Publication>) {
        let next = desired.and_then(|publication| {
            subscribe(&publication.track);
            match publication.track.track()? {
                RemoteTrack::Video(track) => Some((publication, track.rtc_track())),
                _ => None,
            }
        });
        let Some((publication, track)) = next else {
            self.video = None;
            if !self.policy.local_selected() {
                frames.clear();
            }
            return;
        };
        let rtc_id = track.id();
        if !self
            .video
            .as_ref()
            .is_some_and(|active| active.matches(publication, &rtc_id))
        {
            frames.clear();
            self.video = Some(Received {
                sid: publication.sid(),
                rtc_id,
                publication: publication.track.clone(),
                stream: NativeVideoStream::with_options(
                    track,
                    NativeVideoStreamOptions {
                        queue_size_frames: Some(1),
                    },
                ),
            });
        }
    }

    fn sync_audio(&mut self, desired: Option<&Publication>) {
        let next = desired.and_then(|publication| {
            subscribe(&publication.track);
            match publication.track.track()? {
                RemoteTrack::Audio(track) => Some((publication, track.rtc_track())),
                _ => None,
            }
        });
        let Some((publication, track)) = next else {
            self.audio = None;
            return;
        };
        let rtc_id = track.id();
        if !self
            .audio
            .as_ref()
            .is_some_and(|active| active.matches(publication, &rtc_id))
        {
            self.audio = Some(Received {
                sid: publication.sid(),
                rtc_id,
                publication: publication.track.clone(),
                stream: NativeAudioStream::with_options(
                    track,
                    RATE as i32,
                    2,
                    NativeAudioStreamOptions {
                        queue_size_frames: Some(6),
                    },
                ),
            });
        }
    }

    pub fn frame(&mut self, frames: &ShareFrames, preview: Option<Arc<ShareFrame>>, visible: bool) {
        if !visible {
            return;
        }
        if self.policy.local_selected() {
            if let (Some(target), Some(frame)) = (self.policy.target(), preview) {
                frames.set(target, frame);
            }
        } else if let (Some(target), Some(video)) = (self.policy.remote_target(), &mut self.video)
            && let Some(Some(frame)) = video.stream.next().now_or_never()
            && let Some(frame) = ShareFrame::decoded(frame)
        {
            frames.set(target, Arc::new(frame));
        }
    }

    pub fn mix(&mut self, mix: &mut Mix, silent: bool, gain: u16) {
        let Some(audio) = &mut self.audio else { return };
        if silent || gain == 0 || audio.publication.is_muted() {
            while let Some(Some(_)) = audio.stream.next().now_or_never() {}
            return;
        }
        if let Some(Some(frame)) = audio.stream.next().now_or_never()
            && frame.sample_rate == RATE
            && frame.num_channels == 2
            && frame.samples_per_channel == BLOCK_LEN as u32
            && let Ok(samples) = <&StereoBlock>::try_from(frame.data.as_ref())
        {
            mix.add_stereo(samples, gain);
        }
    }
}

fn subscribe(publication: &RemoteTrackPublication) {
    if !publication.is_desired() {
        publication.set_subscribed(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_watch_controls_cannot_change_an_automatic_replacement() {
        let first = ConnectionId::from("a");
        let replacement = ConnectionId::from("b");
        let other = ConnectionId::from("c");
        let mut watcher = ShareReceiver::default();
        watcher.policy.update(
            BTreeSet::from([first.clone(), replacement.clone(), other.clone()]),
            None,
        );
        assert_eq!(watcher.target(), Some(&first));

        watcher
            .policy
            .update(BTreeSet::from([replacement.clone(), other.clone()]), None);
        assert_eq!(watcher.target(), Some(&replacement));
        assert!(!watcher.change_target(Some(&first), None));
        assert!(!watcher.change_target(Some(&first), Some(other.clone())));
        assert_eq!(watcher.target(), Some(&replacement));

        assert!(watcher.change_target(Some(&replacement), None));
        assert!(watcher.change_target(None, Some(other.clone())));
        assert_eq!(watcher.target(), Some(&other));
    }

    #[test]
    fn ordered_publication_removal_resets_dismissal_even_if_replacement_is_already_in_rtc() {
        let id = ConnectionId::from("same-connection");
        let old = || TrackSid::try_from("TR_old".to_owned()).unwrap();
        let replacement = || TrackSid::try_from("TR_replacement".to_owned()).unwrap();
        let mut catalog = ScreenCatalog::default();
        let mut policy = WatchPolicy::default();
        catalog.published(old(), id.clone(), true);
        assert!(policy.update(catalog.active_sharers(), None));
        policy.dismiss();

        catalog.0.remove(&old());
        catalog.set_active(&old(), true);
        assert!(!policy.update(catalog.active_sharers(), None));
        assert!(policy.target().is_none());

        catalog.published(replacement(), id.clone(), true);
        assert!(policy.update(catalog.active_sharers(), None));
        assert_eq!(policy.target(), Some(&id));
    }

    #[test]
    fn frame_slot_only_exposes_current_connection_and_clears_on_switch() {
        let frames = ShareFrames::default();
        let former = ConnectionId::from("a");
        let selected = ConnectionId::from("b");
        let (sink, capture) = super::super::screen_capture();
        sink.rgba(2, 1, 8, &[0; 8]);
        let first = Arc::new(capture.video().unwrap());
        frames.set(&former, first.clone());
        assert!(frames.get(&selected).is_none());
        assert!(Arc::ptr_eq(&frames.get(&former).unwrap(), &first));
        frames.clear();
        assert!(frames.get(&former).is_none());
        sink.rgba(3, 1, 12, &[0; 12]);
        let second = Arc::new(capture.video().unwrap());
        frames.set(&selected, second.clone());
        assert!(frames.get(&former).is_none());
        assert!(Arc::ptr_eq(&frames.get(&selected).unwrap(), &second));
    }

    #[test]
    fn independently_selects_one_video_and_audio_and_keeps_only_audio_when_hidden() {
        let track_kinds = [
            (1, TrackSource::ScreenshareAudio, TrackKind::Audio),
            (2, TrackSource::Camera, TrackKind::Video),
            (3, TrackSource::Screenshare, TrackKind::Video),
            (4, TrackSource::Screenshare, TrackKind::Video),
            (5, TrackSource::ScreenshareAudio, TrackKind::Audio),
            (6, TrackSource::ScreenshareAudio, TrackKind::Video),
        ];
        let candidates = || {
            track_kinds
                .iter()
                .map(|(id, kind, media)| (id, source(*kind, *media)))
        };
        let with_video = desired(true, candidates());
        assert_eq!(with_video.video, Some(&3));
        assert_eq!(with_video.audio, Some(&1));
        let hidden = desired(false, candidates());
        assert_eq!(hidden.video, None);
        assert_eq!(hidden.audio, with_video.audio);
        let dismissed = desired(false, std::iter::empty::<(&i32, Option<Source>)>());
        assert_eq!(dismissed.video, None);
        assert_eq!(dismissed.audio, None);
    }
}
