use super::{VoiceParticipant, VoiceSettings};
use crate::{
    audio::{BLOCK_LEN, Block, Mix, RATE, pcm_loudness},
    model::{ConnectionId, VisitorId},
};
use futures_util::{FutureExt, StreamExt, future::BoxFuture};
use livekit::{
    prelude::{
        LocalAudioTrack, LocalParticipant, LocalTrack, LocalTrackPublication, RemoteTrack,
        RemoteTrackPublication, Room, RoomEvent, RoomResult, TrackKind, TrackPublication,
        TrackPublishOptions, TrackSid, TrackSource,
    },
    rtc_engine::lk_runtime::LkRuntime,
    webrtc::{
        audio_frame::AudioFrame,
        audio_source::{AudioSourceOptions, RtcAudioSource, native::NativeAudioSource},
        audio_stream::native::{NativeAudioStream, NativeAudioStreamOptions},
        native::apm::AudioProcessingModule,
        peer_connection_factory::native::PeerConnectionFactoryExt,
    },
};
use std::{borrow::Cow, collections::HashMap, sync::Arc, time::Duration};
use tokio::{sync::mpsc, time::Instant};

pub(super) fn runtime() -> Arc<LkRuntime> {
    let runtime = LkRuntime::instance();
    let factory = runtime.pc_factory();
    factory.set_adm_recording_enabled(false);
    factory.set_adm_playout_enabled(false);
    runtime
}

pub(super) struct Processor(AudioProcessingModule);

impl Processor {
    pub fn new(settings: &VoiceSettings) -> Self {
        Self(AudioProcessingModule::new(
            settings.echo_cancellation,
            settings.auto_gain,
            true,
            settings.noise_suppression,
        ))
    }

    pub fn reverse(&mut self, block: &mut Block) {
        let _ = self.0.process_reverse_stream(block, RATE as i32, 1);
    }

    pub fn capture(&mut self, block: &mut Block, delay_ms: i32) -> bool {
        let _ = self.0.set_stream_delay_ms(delay_ms);
        self.0.process_stream(block, RATE as i32, 1).is_ok()
    }
}

struct Mic {
    source: NativeAudioSource,
    track: LocalAudioTrack,
    publish: BoxFuture<'static, RoomResult<LocalTrackPublication>>,
}

impl Mic {
    fn new(local: LocalParticipant) -> Self {
        // Processing belongs to the shared APM. With no internal SDK queue, an old
        // capture block cannot be delivered after a release, deafen or room switch.
        let source = NativeAudioSource::new(AudioSourceOptions::default(), RATE, 1, 0);
        let track = LocalAudioTrack::create_audio_track(
            "Microphone",
            RtcAudioSource::Native(source.clone()),
        );
        track.mute();
        let publishing = track.clone();
        let publish = Box::pin(async move {
            local
                .publish_track(
                    LocalTrack::Audio(publishing),
                    TrackPublishOptions {
                        source: TrackSource::Microphone,
                        ..TrackPublishOptions::default()
                    },
                )
                .await
        });
        Self {
            source,
            track,
            publish,
        }
    }
}

struct ReadyMic {
    source: NativeAudioSource,
    track: LocalAudioTrack,
    publication: LocalTrackPublication,
}

struct RemoteMic {
    connection: ConnectionId,
    publication: RemoteTrackPublication,
    stream: NativeAudioStream,
    level: f32,
}

pub(super) struct MediaRoom {
    pub room: Arc<Room>,
    pub events: mpsc::UnboundedReceiver<RoomEvent>,
    tracks: HashMap<TrackSid, RemoteMic>,
    pending_mic: Option<Mic>,
    microphone: Option<ReadyMic>,
    mic_retry_at: Option<Instant>,
    attributes: Option<BoxFuture<'static, RoomResult<()>>>,
    attribute_target: Option<bool>,
    attribute_synced: bool,
    attribute_retry_at: Option<Instant>,
}

impl MediaRoom {
    pub fn new(room: Arc<Room>, events: mpsc::UnboundedReceiver<RoomEvent>) -> Self {
        let media = Self {
            room,
            events,
            tracks: HashMap::new(),
            pending_mic: None,
            microphone: None,
            mic_retry_at: None,
            attributes: None,
            attribute_target: None,
            attribute_synced: false,
            attribute_retry_at: None,
        };
        media.subscribe_existing();
        media
    }

    pub fn close(mut self) {
        self.set_muted(true);
        self.tracks.clear();
        tokio::spawn(async move {
            let _ = self.room.close().await;
        });
    }

    pub fn microphone_ready(&self) -> bool {
        self.microphone.is_some()
    }

    pub fn microphone_failed(&self) -> bool {
        self.mic_retry_at.is_some()
    }

    pub fn service_mic(&mut self, capture_ready: bool, now: Instant) {
        if let Some(pending) = &mut self.pending_mic
            && let Some(result) = pending.publish.as_mut().now_or_never()
        {
            let pending = self.pending_mic.take().expect("pending mic");
            match result {
                Ok(publication) => {
                    self.microphone = Some(ReadyMic {
                        source: pending.source,
                        track: pending.track,
                        publication,
                    });
                    self.mic_retry_at = None;
                }
                Err(_) => self.mic_retry_at = Some(now + Duration::from_secs(5)),
            }
        }
        if capture_ready
            && self.microphone.is_none()
            && self.pending_mic.is_none()
            && self.mic_retry_at.is_none_or(|retry| now >= retry)
        {
            self.pending_mic = Some(Mic::new(self.room.local_participant()));
        }
    }

    pub fn set_muted(&self, muted: bool) {
        if let Some(mic) = &self.microphone
            && mic.publication.is_muted() != muted
        {
            if muted {
                mic.publication.mute();
                mic.source.clear_buffer();
            } else {
                mic.publication.unmute();
            }
        }
    }

    pub fn capture(&self, samples: &Block) {
        if let Some(mic) = &self.microphone
            && !mic.track.is_muted()
        {
            let _ = mic
                .source
                .capture_frame(&AudioFrame {
                    data: Cow::Borrowed(samples),
                    sample_rate: RATE,
                    num_channels: 1,
                    samples_per_channel: BLOCK_LEN as u32,
                })
                .now_or_never();
        }
    }

    pub fn service_attributes(&mut self, deafened: bool, now: Instant) {
        if self.attribute_target != Some(deafened) {
            // A prior update can take the full SDK timeout to acknowledge. Its reply
            // must not delay sending a new local deafen or undeafen state.
            self.attributes = None;
            self.attribute_target = Some(deafened);
            self.attribute_synced = false;
            self.attribute_retry_at = None;
        }
        if let Some(update) = &mut self.attributes
            && let Some(result) = update.as_mut().now_or_never()
        {
            self.attribute_synced = result.is_ok();
            self.attribute_retry_at = result.err().map(|_| now + Duration::from_secs(2));
            self.attributes = None;
        }
        if !self.attribute_synced
            && self.attributes.is_none()
            && self.attribute_retry_at.is_none_or(|retry| now >= retry)
        {
            let local = self.room.local_participant();
            let value = deafened.to_string();
            self.attributes = Some(Box::pin(async move {
                local
                    .set_attributes(HashMap::from([("deafened".into(), value)]))
                    .await
            }));
        }
    }

    fn subscribe_existing(&self) {
        for participant in self.room.remote_participants().into_values() {
            for publication in participant.track_publications().into_values() {
                subscribe(&publication);
            }
        }
    }

    pub fn resume(&mut self) {
        self.attribute_target = None;
        self.attribute_synced = false;
        self.attribute_retry_at = None;
        self.attributes = None;
        if let Some(mic) = &mut self.microphone {
            let current = self
                .room
                .local_participant()
                .track_publications()
                .into_values()
                .find(|publication| {
                    publication
                        .track()
                        .is_some_and(|track| track.rtc_track().id() == mic.track.rtc_track().id())
                });
            if let Some(publication) = current {
                mic.publication = publication;
            } else {
                self.microphone = None;
            }
        }
        self.subscribe_existing();
    }

    pub fn event(&mut self, event: RoomEvent, reconnecting: bool) {
        match event {
            RoomEvent::ParticipantConnected(participant) => {
                for publication in participant.track_publications().into_values() {
                    subscribe(&publication);
                }
            }
            RoomEvent::ParticipantDisconnected(participant) => {
                self.tracks.retain(|_, track| {
                    track.connection.as_str() != participant.identity().as_str()
                });
            }
            RoomEvent::TrackPublished { publication, .. } => subscribe(&publication),
            RoomEvent::TrackSubscribed {
                publication,
                track,
                participant,
            } => {
                if microphone(&publication) {
                    if let RemoteTrack::Audio(track) = track {
                        let stream = NativeAudioStream::with_options(
                            track.rtc_track(),
                            RATE as i32,
                            1,
                            NativeAudioStreamOptions {
                                queue_size_frames: Some(6),
                            },
                        );
                        self.tracks.insert(
                            publication.sid(),
                            RemoteMic {
                                connection: ConnectionId::from(participant.identity().as_str()),
                                publication,
                                stream,
                                level: 0.0,
                            },
                        );
                    }
                } else {
                    publication.set_subscribed(false);
                }
            }
            RoomEvent::TrackUnpublished { publication, .. }
            | RoomEvent::TrackUnsubscribed { publication, .. } => {
                self.tracks.remove(&publication.sid());
            }
            RoomEvent::LocalTrackPublished {
                publication,
                track: LocalTrack::Audio(track),
                ..
            }
            | RoomEvent::LocalTrackRepublished {
                publication,
                track: LocalTrack::Audio(track),
                ..
            } => {
                if let Some(mic) = &mut self.microphone
                    && mic.track.rtc_track().id() == track.rtc_track().id()
                {
                    mic.publication = publication;
                }
            }
            RoomEvent::LocalTrackUnpublished { publication, .. } if !reconnecting => {
                if self
                    .microphone
                    .as_ref()
                    .is_some_and(|mic| mic.publication.sid() == publication.sid())
                {
                    self.microphone = None;
                }
            }
            RoomEvent::TrackMuted {
                publication: TrackPublication::Remote(publication),
                ..
            } => {
                if let Some(track) = self.tracks.get_mut(&publication.sid()) {
                    track.level = 0.0;
                    while let Some(Some(_)) = track.stream.next().now_or_never() {}
                }
            }
            _ => {}
        }
    }

    pub fn mix(&mut self, mix: &mut Mix, silent: bool, gain: impl Fn(&ConnectionId) -> u16) {
        for remote in self.tracks.values_mut() {
            let block = remote
                .stream
                .next()
                .now_or_never()
                .flatten()
                .and_then(|sample| {
                    if sample.sample_rate == RATE
                        && sample.num_channels == 1
                        && sample.samples_per_channel == BLOCK_LEN as u32
                    {
                        <Block>::try_from(sample.data.as_ref()).ok()
                    } else {
                        None
                    }
                });
            if let Some(block) = block.filter(|_| !remote.publication.is_muted()) {
                let level = pcm_loudness(&block);
                remote.level = smooth(remote.level, level);
                if !silent {
                    mix.add(&block, gain(&remote.connection));
                }
            } else {
                remote.level = smooth(remote.level, 0.0);
            }
        }
    }

    pub fn participants(
        &self,
        self_connection: &ConnectionId,
        muted: bool,
        deafened: bool,
        mic_level: f32,
    ) -> Vec<VoiceParticipant> {
        let local = self.room.local_participant();
        let mut participants = vec![VoiceParticipant {
            connection_id: self_connection.clone(),
            visitor_id: visitor_id(self_connection),
            name: local.name(),
            local: true,
            muted,
            deafened,
            camera: false,
            screen: false,
            speaking: !muted && (local.is_speaking() || mic_level > 0.22),
            level: if muted { 0.0 } else { mic_level },
        }];
        for remote in self.room.remote_participants().into_values() {
            let connection_id = ConnectionId::from(remote.identity().as_str());
            let muted = !remote
                .track_publications()
                .values()
                .any(|publication| microphone(publication) && !publication.is_muted());
            let publications = remote.track_publications();
            let has_active = |source| {
                publications
                    .values()
                    .any(|publication| publication.source() == source && !publication.is_muted())
            };
            let level = self
                .tracks
                .values()
                .filter(|track| track.connection == connection_id)
                .map(|track| track.level)
                .fold(0.0f32, f32::max);
            participants.push(VoiceParticipant {
                visitor_id: visitor_id(&connection_id),
                connection_id,
                name: remote.name(),
                local: false,
                muted,
                deafened: remote
                    .attributes()
                    .get("deafened")
                    .is_some_and(|value| value == "true"),
                camera: has_active(TrackSource::Camera),
                screen: has_active(TrackSource::Screenshare),
                speaking: !muted && (remote.is_speaking() || level > 0.22),
                level: if muted { 0.0 } else { level },
            });
        }
        participants[1..].sort_by(|a, b| {
            a.name
                .cmp(&b.name)
                .then(a.connection_id.cmp(&b.connection_id))
        });
        participants
    }
}

fn visitor_id(connection: &ConnectionId) -> VisitorId {
    VisitorId::from(connection.as_str().split('.').next().unwrap_or_default())
}

pub(super) fn smooth(previous: f32, current: f32) -> f32 {
    let value = if current >= previous {
        current
    } else {
        previous * 0.82
    };
    if value < 0.002 { 0.0 } else { value }
}

fn microphone(publication: &RemoteTrackPublication) -> bool {
    is_microphone(publication.source(), publication.kind())
}

fn is_microphone(source: TrackSource, kind: TrackKind) -> bool {
    source == TrackSource::Microphone && kind == TrackKind::Audio
}

fn subscribe(publication: &RemoteTrackPublication) {
    if microphone(publication) {
        publication.set_subscribed(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_microphone_audio_is_eligible_for_subscription() {
        assert!(is_microphone(TrackSource::Microphone, TrackKind::Audio));
        assert!(!is_microphone(TrackSource::Microphone, TrackKind::Video));
        for source in [
            TrackSource::Unknown,
            TrackSource::Camera,
            TrackSource::Screenshare,
            TrackSource::ScreenshareAudio,
        ] {
            assert!(!is_microphone(source, TrackKind::Audio));
            assert!(!is_microphone(source, TrackKind::Video));
        }
    }
}
