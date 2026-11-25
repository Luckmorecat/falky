use super::{HoldSource, VoiceSettings};
use std::time::Duration;
use tokio::time::Instant;

const MAX_OBSERVED_GAP: Duration = Duration::from_millis(80);
const ACTIVITY_LEVEL: f32 = 0.15;

#[derive(Default)]
pub(super) struct MicPolicy {
    manual_mute: bool,
    pub deafened: bool,
    holds: u8,
    last_measurement: Option<Instant>,
    silent_for: Duration,
}

impl MicPolicy {
    pub fn new(join_muted: bool) -> Self {
        Self {
            manual_mute: join_muted,
            ..Self::default()
        }
    }

    pub fn for_switch(&self) -> Self {
        Self {
            manual_mute: self.manual_mute,
            deafened: self.deafened,
            ..Self::default()
        }
    }

    pub fn muted(&self, ptt: bool) -> bool {
        self.deafened
            || if ptt {
                self.holds == 0
            } else {
                self.manual_mute
            }
    }

    pub fn set_muted(&mut self, muted: bool, ptt: bool) {
        if muted || !ptt {
            self.manual_mute = muted;
            self.release_all();
        }
    }

    pub fn set_deafened(&mut self, deafened: bool) {
        if self.deafened != deafened {
            self.deafened = deafened;
            self.release_all();
        }
    }

    pub fn hold(&mut self, source: HoldSource, held: bool, permitted: bool) {
        let mask = 1 << source as u8;
        if held && permitted && !self.deafened {
            self.holds |= mask;
        }
        if !held {
            self.holds &= !mask;
        }
    }

    pub fn release_local(&mut self) {
        self.holds &= 1 << HoldSource::Global as u8;
    }

    pub fn release_all(&mut self) {
        self.holds = 0;
        self.reset_away();
    }

    pub fn reset_away(&mut self) {
        self.last_measurement = None;
        self.silent_for = Duration::ZERO;
    }

    pub fn observe(
        &mut self,
        settings: &VoiceSettings,
        now: Instant,
        level: Option<f32>,
    ) -> Option<u16> {
        let can_measure = settings.away_mute && !settings.push_to_talk && !self.muted(false);
        if !can_measure || level.is_none_or(|level| level > ACTIVITY_LEVEL) {
            self.reset_away();
            return None;
        }

        let gap = self
            .last_measurement
            .replace(now)
            .map(|previous| now - previous);
        self.silent_for = match gap {
            Some(gap) if gap <= MAX_OBSERVED_GAP => self.silent_for + gap,
            _ => Duration::ZERO,
        };
        let minutes = settings.away_minutes;
        if self.silent_for >= Duration::from_secs(u64::from(minutes) * 60) {
            self.set_muted(true, false);
            Some(minutes)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_focus_loss_and_release_preserve_other_held_sources() {
        let mut p = MicPolicy::new(false);
        assert!(p.muted(true));
        p.hold(HoldSource::Global, true, true);
        p.hold(HoldSource::InApp, true, true);
        p.hold(HoldSource::DockPointer, true, true);
        assert!(!p.muted(true));
        p.release_local();
        assert!(!p.muted(true));
        p.hold(HoldSource::Global, false, true);
        assert!(p.muted(true));
    }

    #[test]
    fn deafen_restores_ordinary_mute_but_requires_a_fresh_ptt_press() {
        let mut p = MicPolicy::new(false);
        p.hold(HoldSource::DockPointer, true, true);
        assert!(!p.muted(true));
        p.set_deafened(true);
        assert!(p.muted(false));
        p.hold(HoldSource::Global, true, true);
        p.set_deafened(false);
        assert!(!p.muted(false));
        assert!(p.muted(true));
        p.set_muted(false, true);
        assert!(p.muted(true));
        p.hold(HoldSource::Global, true, false);
        assert!(p.muted(true));
    }

    #[test]
    fn a_room_switch_preserves_mute_and_deafen_without_carrying_holds() {
        let mut policy = MicPolicy::new(false);
        policy.hold(HoldSource::Global, true, true);
        assert!(!policy.muted(true));
        let switched = policy.for_switch();
        assert!(switched.muted(true));
        assert!(!switched.muted(false));

        policy.set_muted(true, false);
        policy.set_deafened(true);
        let mut switched = policy.for_switch();
        assert!(switched.deafened);
        switched.set_deafened(false);
        assert!(switched.muted(false));
    }

    #[test]
    fn away_counts_only_observed_silence_and_stays_muted() {
        let mut p = MicPolicy::new(false);
        let settings = VoiceSettings {
            away_minutes: 5,
            ..VoiceSettings::default()
        };
        let start = Instant::now();
        let tick = Duration::from_millis(20);
        for index in 0..15_000 {
            assert_eq!(p.observe(&settings, start + tick * index, Some(0.01)), None);
        }
        let after_suspend = start + Duration::from_secs(600);
        assert_eq!(p.observe(&settings, after_suspend, Some(0.01)), None);
        assert_eq!(p.observe(&settings, after_suspend + tick, None), None);
        assert_eq!(
            p.observe(&settings, after_suspend + tick * 2, Some(0.2)),
            None
        );
        let resumed = after_suspend + tick * 3;
        for index in 0..15_000 {
            assert_eq!(
                p.observe(&settings, resumed + tick * index, Some(0.01)),
                None
            );
        }
        assert_eq!(
            p.observe(&settings, resumed + tick * 15_000, Some(0.01)),
            Some(5)
        );
        assert!(p.muted(false));
        assert_eq!(
            p.observe(&settings, resumed + tick * 15_001, Some(0.8)),
            None
        );
        assert!(p.muted(false));
    }
}
