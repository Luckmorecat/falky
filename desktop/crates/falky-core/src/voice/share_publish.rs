use super::{ScreenCapture, ShareFrame, VoiceNotice, media, screen_capture::PublishFrame};
use crate::audio::{BLOCK_LEN, RATE, STEREO_SILENCE, StereoBlock};
use futures_util::FutureExt;
use livekit::{
    options::{
        DegradationPreference, VideoCodec, VideoEncoderBackend, VideoEncoding,
        audio::MUSIC_HIGH_QUALITY_STEREO,
    },
    prelude::{
        ConnectionState, LocalAudioTrack, LocalParticipant, LocalTrack, LocalTrackPublication,
        LocalVideoTrack, Room, RoomResult, TrackPublishOptions, TrackSid, TrackSource,
    },
    webrtc::{
        audio_frame::AudioFrame,
        audio_source::{AudioSourceOptions, RtcAudioSource, native::NativeAudioSource},
        video_frame::{VideoFrame, VideoRotation},
        video_source::{RtcVideoSource, VideoResolution, native::NativeVideoSource},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{task::JoinHandle, time::Instant};

const STREAM: &str = "screen_share";
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareCodec {
    #[default]
    Vp8,
    H264,
    Vp9,
    Av1,
    H265,
}

impl ShareCodec {
    fn sdk(self) -> VideoCodec {
        match self {
            Self::Vp8 => VideoCodec::VP8,
            Self::H264 => VideoCodec::H264,
            Self::Vp9 => VideoCodec::VP9,
            Self::Av1 => VideoCodec::AV1,
            Self::H265 => VideoCodec::H265,
        }
    }

    fn resolve(self, supported: &[Self]) -> Self {
        if supported.contains(&self) {
            self
        } else {
            Self::Vp8
        }
    }
}

pub fn supported_share_codecs() -> Vec<ShareCodec> {
    static SUPPORTED: OnceLock<Vec<ShareCodec>> = OnceLock::new();
    SUPPORTED
        .get_or_init(|| {
            let supported = media::runtime()
                .pc_factory()
                .video_encoder_codecs(VideoEncoderBackend::Auto);
            [
                ShareCodec::Vp8,
                ShareCodec::H264,
                ShareCodec::Vp9,
                ShareCodec::Av1,
                ShareCodec::H265,
            ]
            .into_iter()
            .filter(|codec| supported.contains(&codec.sdk().into()))
            .collect()
        })
        .clone()
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareFocus {
    #[default]
    Motion,
    Detail,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SharePublishSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub focus: ShareFocus,
    pub codec: ShareCodec,
    pub bitrate_bps: Option<u64>,
}

impl Default for SharePublishSettings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
            focus: ShareFocus::Motion,
            codec: ShareCodec::Vp8,
            bitrate_bps: None,
        }
    }
}

impl SharePublishSettings {
    fn validated(mut self) -> Self {
        self.width = self.width.clamp(1, 8192);
        self.height = self.height.clamp(1, 8192);
        self.fps = self.fps.clamp(1, 60);
        self.codec = self.codec.resolve(&supported_share_codecs());
        self
    }

    fn encoding(self) -> VideoEncoding {
        let base = match self.height {
            0..=720 => 2_500_000,
            721..=1080 => 5_000_000,
            _ => 8_000_000,
        };
        let auto = match self.fps {
            0..=15 => base * 7 / 10,
            16..=30 => base,
            _ => base * 3 / 2,
        };
        VideoEncoding {
            max_bitrate: self
                .bitrate_bps
                .filter(|value| *value != 0)
                .unwrap_or(auto)
                .min(20_000_000),
            max_framerate: f64::from(self.fps),
        }
    }
}

/// Capture lifetime and signals are separate from SDK publication and mic policy.
#[derive(Default)]
pub(super) struct SharePublisher {
    active: Option<LocalShare>,
    retiring: Vec<RetiredTrack>,
    publication_epoch: u64,
}

impl SharePublisher {
    pub fn start(
        &mut self,
        capture: ScreenCapture,
        native: Box<dyn Send>,
        settings: SharePublishSettings,
        with_audio: bool,
        now: Instant,
    ) {
        if self.active.is_none() {
            self.active = Some(LocalShare::new(
                capture,
                native,
                settings.validated(),
                with_audio,
                now,
            ));
        }
    }

    pub fn sharing(&self) -> bool {
        self.active.as_ref().is_some_and(|share| share.established)
    }

    pub fn publishing(&self) -> bool {
        self.active.is_some() && !self.sharing()
    }

    pub fn preview(&self) -> Option<Arc<ShareFrame>> {
        self.active.as_ref()?.preview.clone()
    }

    pub fn stop(&mut self) {
        if let Some(share) = self.active.take() {
            let LocalShare { video, audio, .. } = share;
            self.retiring.extend(
                [
                    video.map(|video| video.track),
                    audio.map(|audio| audio.track),
                ]
                .into_iter()
                .flatten()
                .map(PublishedTrack::retire),
            );
        }
    }

    pub fn resume(&mut self, local: &LocalParticipant) {
        self.publication_epoch += 1;
        if let Some(share) = &mut self.active {
            share.last_sent_at = None;
            for track in [
                share.video.as_mut().map(|video| &mut video.track),
                share.audio.as_mut().map(|audio| &mut audio.track),
            ]
            .into_iter()
            .flatten()
            {
                track.reconcile(local);
            }
        }
    }

    pub fn published(
        &mut self,
        local: &LocalParticipant,
        publication: LocalTrackPublication,
        track: LocalTrack,
    ) {
        let id = track.rtc_track().id();
        let current = self
            .active
            .as_mut()
            .and_then(|share| match publication.source() {
                TrackSource::Screenshare => share.video.as_mut().map(|video| &mut video.track),
                TrackSource::ScreenshareAudio => share.audio.as_mut().map(|audio| &mut audio.track),
                _ => None,
            });
        if let Some(current) = current.filter(|current| current.id == id) {
            current.reconcile(local);
        } else {
            mute(&track);
            if !self.retiring.iter().any(|retired| retired.rtc_id == id) {
                self.retiring.push(RetiredTrack {
                    rtc_id: id,
                    pending: None,
                });
            }
        }
    }

    pub fn unpublished(&mut self, local: &LocalParticipant, sid: &TrackSid) {
        if let Some(share) = &mut self.active {
            for track in [
                share.video.as_mut().map(|video| &mut video.track),
                share.audio.as_mut().map(|audio| &mut audio.track),
            ]
            .into_iter()
            .flatten()
            {
                if track.publication.as_ref() == Some(sid) {
                    track.reconcile(local);
                }
            }
        }
    }

    pub fn service(&mut self, room: &Room, connected: bool, now: Instant) -> Option<VoiceNotice> {
        let local = room.local_participant();
        self.retiring.retain(|retired| {
            // The SDK's full reconnect snapshots publication objects that it
            // later repackages. Unpublishing during that interval clears their
            // tracks before the SDK reads them.
            if !retired.ready(connected && room.connection_state() == ConnectionState::Connected) {
                return true;
            }
            if let Some(sid) = matching_publication(&local, &retired.rtc_id) {
                if room.connection_state() != ConnectionState::Connected {
                    return true;
                }
                // The pinned SDK completes unpublish_track without suspending.
                return local.unpublish_track(&sid).now_or_never().is_none();
            }
            false
        });
        let share = self.active.as_mut()?;
        if share.capture.source_lost() {
            self.stop();
            return Some(VoiceNotice::ShareSourceLost);
        }

        let can_publish = connected && self.retiring.is_empty();
        if let Some(frame) = share.next_video(now) {
            let video = share
                .video
                .get_or_insert_with(|| ShareVideo::new(&frame, share.settings));
            if connected {
                video.capture(frame.clone(), false);
                share.last_sent_at = Some(now);
            }
            share.preview = Some(frame);
        }
        if share.initial_frame_expired(now) {
            self.stop();
            return Some(VoiceNotice::SharePublishFailed);
        }

        if let Some(video) = &mut share.video {
            if !video
                .track
                .service(&local, can_publish, self.publication_epoch)
            {
                self.stop();
                return Some(VoiceNotice::SharePublishFailed);
            }
            if video.track.publication.is_some() {
                if !share.established {
                    share.last_sent_at = None;
                }
                share.established = true;
                if connected
                    && share
                        .last_sent_at
                        .is_none_or(|sent| now.duration_since(sent) >= Duration::from_secs(1))
                    && let Some(frame) = &share.preview
                {
                    video.capture(frame.clone(), true);
                    share.last_sent_at = Some(now);
                }
            }
        }

        if !share.with_audio {
            return None;
        }
        if share.capture.audio_unavailable() {
            share.with_audio = false;
            if let Some(audio) = share.audio.take() {
                self.retiring.push(audio.track.retire());
            }
            return Some(VoiceNotice::ShareAudioUnavailable);
        }
        let block = share.capture.stereo();
        share.received_audio |= block.is_some();
        if share.established && share.received_audio && share.audio.is_none() {
            share.audio = Some(ShareAudio::new());
        }
        if let Some(audio) = &mut share.audio {
            if !audio.track.service(
                &local,
                can_publish && share.established,
                self.publication_epoch,
            ) {
                share.with_audio = false;
                let audio = share.audio.take().expect("screen share audio");
                self.retiring.push(audio.track.retire());
                return Some(VoiceNotice::ShareAudioUnavailable);
            }
            if connected && audio.track.publication.is_some() {
                audio.capture(block.as_ref().unwrap_or(&STEREO_SILENCE));
            }
        }
        None
    }
}

struct LocalShare {
    capture: ScreenCapture,
    _native: Box<dyn Send>,
    settings: SharePublishSettings,
    with_audio: bool,
    video: Option<ShareVideo>,
    audio: Option<ShareAudio>,
    preview: Option<Arc<ShareFrame>>,
    next_video_at: Option<Instant>,
    first_frame_deadline: Option<Instant>,
    last_sent_at: Option<Instant>,
    received_audio: bool,
    established: bool,
}

impl LocalShare {
    fn new(
        capture: ScreenCapture,
        native: Box<dyn Send>,
        settings: SharePublishSettings,
        with_audio: bool,
        now: Instant,
    ) -> Self {
        Self {
            capture,
            _native: native,
            settings,
            with_audio,
            video: None,
            audio: None,
            preview: None,
            next_video_at: None,
            first_frame_deadline: Some(now + FIRST_FRAME_TIMEOUT),
            last_sent_at: None,
            received_audio: false,
            established: false,
        }
    }

    fn initial_frame_expired(&self, now: Instant) -> bool {
        self.first_frame_deadline
            .is_some_and(|deadline| now >= deadline)
    }

    fn next_video(&mut self, now: Instant) -> Option<Arc<ShareFrame>> {
        let interval = Duration::from_micros(1_000_000 / u64::from(self.settings.fps));
        let due = self.next_video_at.unwrap_or(now);
        if now < due {
            return None;
        }
        let frame = self
            .capture
            .video()?
            .bounded(self.settings.width, self.settings.height);
        self.first_frame_deadline = None;
        self.next_video_at = Some(if now.duration_since(due) < interval {
            due + interval
        } else {
            now + interval
        });
        Some(Arc::new(frame))
    }
}

struct ShareVideo {
    source: NativeVideoSource,
    track: PublishedTrack,
}

impl ShareVideo {
    fn new(frame: &ShareFrame, settings: SharePublishSettings) -> Self {
        let source = NativeVideoSource::new(
            VideoResolution {
                width: frame.width,
                height: frame.height,
            },
            true,
        );
        let track = LocalVideoTrack::create_video_track(
            "Screen share",
            RtcVideoSource::Native(source.clone()),
        );
        let track = PublishedTrack::new(
            LocalTrack::Video(track),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                stream: STREAM.into(),
                video_codec: settings.codec.sdk(),
                video_encoding: Some(settings.encoding()),
                degradation_preference: Some(match settings.focus {
                    ShareFocus::Motion => DegradationPreference::MaintainFramerate,
                    ShareFocus::Detail => DegradationPreference::MaintainResolution,
                }),
                simulcast: false,
                ..TrackPublishOptions::default()
            },
        );
        Self { source, track }
    }

    fn capture(&self, frame: Arc<ShareFrame>, refresh: bool) {
        let mut video = VideoFrame::new(VideoRotation::VideoRotation0, PublishFrame(frame));
        if !refresh {
            video.timestamp_us = video.buffer.0.timestamp_us;
        }
        self.source.capture_frame(&video);
    }
}

struct ShareAudio {
    source: NativeAudioSource,
    track: PublishedTrack,
}

impl ShareAudio {
    fn new() -> Self {
        let source = NativeAudioSource::new(AudioSourceOptions::default(), RATE, 2, 0);
        let track = LocalAudioTrack::create_audio_track(
            "Screen share audio",
            RtcAudioSource::Native(source.clone()),
        );
        let track = PublishedTrack::new(
            LocalTrack::Audio(track),
            TrackPublishOptions {
                source: TrackSource::ScreenshareAudio,
                stream: STREAM.into(),
                audio_encoding: Some(MUSIC_HIGH_QUALITY_STEREO.encoding.clone()),
                dtx: false,
                red: false,
                ..TrackPublishOptions::default()
            },
        );
        Self { source, track }
    }

    fn capture(&self, samples: &StereoBlock) {
        let _ = self
            .source
            .capture_frame(&AudioFrame {
                data: Cow::Borrowed(samples),
                sample_rate: RATE,
                num_channels: 2,
                samples_per_channel: BLOCK_LEN as u32,
            })
            .now_or_never();
    }
}

struct PublishedTrack {
    track: LocalTrack,
    id: String,
    options: TrackPublishOptions,
    publication: Option<TrackSid>,
    pending: Option<(u64, JoinHandle<RoomResult<LocalTrackPublication>>)>,
}

impl PublishedTrack {
    fn new(track: LocalTrack, options: TrackPublishOptions) -> Self {
        Self {
            id: track.rtc_track().id(),
            track,
            options,
            publication: None,
            pending: None,
        }
    }

    fn reconcile(&mut self, local: &LocalParticipant) {
        self.publication = matching_publication(local, &self.id);
    }

    fn service(&mut self, local: &LocalParticipant, connected: bool, epoch: u64) -> bool {
        if self
            .pending
            .as_ref()
            .is_some_and(|(_, task)| task.is_finished())
        {
            let (started, task) = self.pending.take().expect("finished publication");
            let succeeded = task
                .now_or_never()
                .is_some_and(|result| result.is_ok_and(|result| result.is_ok()));
            self.reconcile(local);
            if !succeeded && self.publication.is_none() && connected && started == epoch {
                return false;
            }
        }
        if connected && self.publication.is_none() && self.pending.is_none() {
            let track = self.track.clone();
            let local = local.clone();
            let options = self.options.clone();
            self.pending = Some((
                epoch,
                tokio::spawn(async move { local.publish_track(track, options).await }),
            ));
        }
        true
    }

    fn retire(self) -> RetiredTrack {
        mute(&self.track);
        RetiredTrack {
            rtc_id: self.id,
            pending: self.pending.map(|(_, pending)| pending),
        }
    }
}

struct RetiredTrack {
    rtc_id: String,
    pending: Option<JoinHandle<RoomResult<LocalTrackPublication>>>,
}

impl RetiredTrack {
    fn ready(&self, connected: bool) -> bool {
        connected && self.pending.as_ref().is_none_or(JoinHandle::is_finished)
    }
}

fn mute(track: &LocalTrack) {
    match track {
        LocalTrack::Video(track) => track.mute(),
        LocalTrack::Audio(track) => track.mute(),
    }
}

fn matching_publication(local: &LocalParticipant, rtc_id: &str) -> Option<TrackSid> {
    reconciled_sid(
        rtc_id,
        local
            .track_publications()
            .into_values()
            .filter_map(|publication| {
                let track = publication.track()?;
                Some((track.rtc_track().id(), publication.sid()))
            }),
    )
}

fn reconciled_sid(
    rtc_id: &str,
    mut publications: impl Iterator<Item = (String, TrackSid)>,
) -> Option<TrackSid> {
    publications.find_map(|(id, sid)| (id == rtc_id).then_some(sid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_frame_deadline_only_applies_before_valid_capture() {
        let (sink, capture) = crate::voice::screen_capture();
        let now = Instant::now();
        let mut share = LocalShare::new(
            capture,
            Box::new(()),
            SharePublishSettings::default(),
            false,
            now,
        );
        assert!(!share.initial_frame_expired(now));
        assert!(share.initial_frame_expired(now + FIRST_FRAME_TIMEOUT));
        sink.bgra(2, 2, 8, &[0; 8]);
        assert!(share.next_video(now).is_none());
        assert!(share.initial_frame_expired(now + FIRST_FRAME_TIMEOUT));
        sink.bgra(2, 2, 8, &[0; 16]);
        assert!(share.next_video(now).is_some());
        assert!(!share.initial_frame_expired(now + FIRST_FRAME_TIMEOUT));
    }

    #[tokio::test]
    async fn retired_track_waits_for_pending_publish_and_reconnect() {
        let (finished, pending) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            pending.await.unwrap();
            Err(livekit::prelude::RoomError::AlreadyClosed)
        });
        let mut retired = RetiredTrack {
            rtc_id: "capture".into(),
            pending: Some(task),
        };
        assert!(!retired.ready(true));
        finished.send(()).unwrap();
        let _ = retired.pending.as_mut().unwrap().await;
        assert!(!retired.ready(false));
        assert!(retired.ready(true));
    }

    #[test]
    fn reconnect_reuses_the_same_source_with_a_new_sid() {
        let publications = || {
            [
                (
                    "old-capture".to_owned(),
                    TrackSid::try_from("TR_old".to_owned()).unwrap(),
                ),
                (
                    "capture-video".to_owned(),
                    TrackSid::try_from("TR_republished".to_owned()).unwrap(),
                ),
                (
                    "capture-audio".to_owned(),
                    TrackSid::try_from("TR_audio".to_owned()).unwrap(),
                ),
            ]
            .into_iter()
        };
        assert_eq!(
            reconciled_sid("capture-video", publications())
                .unwrap()
                .as_str(),
            "TR_republished"
        );
        assert_eq!(
            reconciled_sid("capture-audio", publications())
                .unwrap()
                .as_str(),
            "TR_audio"
        );
        assert!(reconciled_sid("missing-capture", publications()).is_none());
    }

    #[test]
    fn settings_use_supported_codec_and_web_bitrates() {
        assert_eq!(
            ShareCodec::H265.resolve(&[ShareCodec::Vp8, ShareCodec::H264]),
            ShareCodec::Vp8
        );
        assert_eq!(
            ShareCodec::H264.resolve(&[ShareCodec::Vp8, ShareCodec::H264]),
            ShareCodec::H264
        );
        let docs = SharePublishSettings {
            height: 1440,
            fps: 15,
            ..SharePublishSettings::default()
        };
        assert_eq!(docs.encoding().max_bitrate, 5_600_000);
        assert_eq!(docs.encoding().max_framerate, 15.0);
        let games = SharePublishSettings {
            fps: 60,
            ..SharePublishSettings::default()
        };
        assert_eq!(games.encoding().max_bitrate, 7_500_000);
    }
}
