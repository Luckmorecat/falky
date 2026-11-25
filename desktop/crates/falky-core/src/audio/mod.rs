mod device;
mod identity;

pub(crate) use device::{AudioIo, DeviceConfig};

pub(crate) const RATE: u32 = 48_000;
pub(crate) const BLOCK_LEN: usize = RATE as usize / 100;
pub(crate) type Block = [i16; BLOCK_LEN];
pub(crate) type StereoBlock = [i16; BLOCK_LEN * 2];
pub(crate) const STEREO_SILENCE: StereoBlock = [0; BLOCK_LEN * 2];
pub(crate) const SILENCE: Block = [0; BLOCK_LEN];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AudioDevices {
    pub input: Vec<AudioDevice>,
    pub output: Vec<AudioDevice>,
}

pub const fn gain_percent(value: u16) -> u16 {
    let bounded = if value > 200 { 200 } else { value };
    (bounded + 2) / 5 * 5
}

pub fn soft_clip(value: f32) -> f32 {
    let size = value.abs();
    if size <= 0.8 {
        value
    } else {
        value.signum() * (0.8 + 0.2 * ((size - 0.8) / 0.2).tanh())
    }
}

pub fn loudness(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy: f32 = samples.iter().map(|sample| sample * sample).sum();
    ((energy / samples.len() as f32).sqrt().sqrt() * 1.75 - 0.12).clamp(0.0, 1.0)
}

pub(crate) fn pcm_loudness(samples: &Block) -> f32 {
    loudness(&samples.map(normalize))
}

fn normalize(sample: i16) -> f32 {
    f32::from(sample) / 32768.0
}

fn quantize(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * 32768.0).round() as i16
}

pub(crate) struct Mix {
    // Apply the knee after summing all tracks and cues.
    samples: [f32; BLOCK_LEN * 2],
}

impl Default for Mix {
    fn default() -> Self {
        Self {
            samples: [0.0; BLOCK_LEN * 2],
        }
    }
}

impl Mix {
    pub fn add(&mut self, samples: &Block, gain: u16) {
        let gain = f32::from(gain) / 100.0;
        for (pair, sample) in self.samples.as_chunks_mut::<2>().0.iter_mut().zip(samples) {
            let voice = normalize(*sample) * gain;
            pair[0] += voice;
            pair[1] += voice;
        }
    }

    pub fn add_stereo(&mut self, samples: &StereoBlock, gain: u16) {
        let gain = f32::from(gain) / 100.0;
        for (sum, sample) in self.samples.iter_mut().zip(samples) {
            *sum += normalize(*sample) * gain;
        }
    }

    pub fn finish(self) -> StereoBlock {
        self.samples.map(|sample| quantize(soft_clip(sample)))
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Cue {
    Join,
    Leave,
    Share,
    Test,
}

pub(crate) struct Chime {
    cue: Cue,
    offset: usize,
}

impl Chime {
    pub fn new(cue: Cue) -> Self {
        Self { cue, offset: 0 }
    }

    pub fn next(&mut self) -> Option<Block> {
        let (count, low, high, gap, decay, peak) = match self.cue {
            Cue::Join => (6, 380.0_f32, 1250.0, 0.055, 0.09, 0.55),
            Cue::Leave => (5, 1050.0, 340.0, 0.06, 0.09, 0.5),
            Cue::Share => (4, 640.0, 820.0, 0.08, 0.09, 0.5),
            Cue::Test => (7, 420.0, 1100.0, 0.07, 0.1, 0.55),
        };
        let attack = 0.003;
        if self.offset as f32 / RATE as f32 >= (count - 1) as f32 * gap + attack + decay {
            return None;
        }
        let block = std::array::from_fn(|index| {
            let elapsed = (self.offset + index) as f32 / RATE as f32;
            let mut sum = 0.0;
            for note in 0..count {
                let age = elapsed - note as f32 * gap;
                if !(0.0..attack + decay).contains(&age) {
                    continue;
                }
                let pitch = low * (high / low).powf(note as f32 / (count - 1) as f32);
                let frequency_rate = 1.55_f32.ln() / decay;
                let phase = std::f32::consts::TAU * pitch * (age * frequency_rate).exp_m1()
                    / frequency_rate;
                let envelope = if age < attack {
                    age / attack
                } else {
                    (-8.0 * (age - attack) / decay).exp()
                };
                sum += phase.sin() * envelope * peak * 0.3;
            }
            quantize(sum)
        });
        self.offset += BLOCK_LEN;
        Some(block)
    }

    pub fn is_test(&self) -> bool {
        matches!(self.cue, Cue::Test)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_soft_clip_vectors() {
        for value in [-0.8, -0.5, 0.0, 0.5, 0.8] {
            assert_eq!(soft_clip(value), value);
        }
        assert!((soft_clip(1.0) - 0.952_319).abs() < 1e-6);
        assert_eq!(soft_clip(-1.0), -soft_clip(1.0));
        assert!(soft_clip(1.5) > soft_clip(1.0));
        assert!(soft_clip(1.5) < 1.0);
    }

    #[test]
    fn web_meter_vectors() {
        assert_eq!(loudness(&[]), 0.0);
        assert_eq!(loudness(&[0.0; 32]), 0.0);
        assert_eq!(loudness(&[1.0, -1.0]), 1.0);
        assert!((loudness(&[0.04, -0.04]) - 0.23).abs() < 1e-5);
        assert!(loudness(&[0.4, 0.0]) > loudness(&[0.05, 0.0]));
    }

    #[test]
    fn mixer_quantizes_gain_and_applies_the_knee_once() {
        assert_eq!(gain_percent(97), 95);
        assert_eq!(gain_percent(98), 100);
        assert_eq!(gain_percent(102), 100);
        assert_eq!(gain_percent(103), 105);
        assert_eq!(gain_percent(u16::MAX), 200);
        let mut mix = Mix::default();
        mix.add(&[16384; BLOCK_LEN], 150);
        mix.add(&[16384; BLOCK_LEN], 50);
        mix.add(&[i16::MAX; BLOCK_LEN], 0);
        assert_eq!(mix.finish(), [quantize(soft_clip(1.0)); BLOCK_LEN * 2]);
    }

    #[test]
    fn stereo_share_is_independent_of_mono_voice_gain_and_uses_the_same_knee() {
        let stereo = std::array::from_fn(|index| if index % 2 == 0 { 16384 } else { -8192 });
        let mut mix = Mix::default();
        mix.add(&[i16::MAX; BLOCK_LEN], 0);
        mix.add_stereo(&stereo, 100);
        assert_eq!(mix.finish(), stereo);
        let mut mix = Mix::default();
        mix.add(&[8192; BLOCK_LEN], 100);
        mix.add_stereo(&stereo, 200);
        assert_eq!(mix.finish()[..2], [quantize(soft_clip(1.25)), -8192]);
    }

    #[test]
    fn synthesized_cues_have_bounded_playback_and_audible_energy() {
        for cue in [Cue::Join, Cue::Leave, Cue::Share, Cue::Test] {
            let mut chime = Chime::new(cue);
            let blocks: Vec<_> = std::iter::from_fn(|| chime.next()).collect();
            assert!((30..60).contains(&blocks.len()));
            assert!(blocks.iter().any(|block| pcm_loudness(block) > 0.2));
        }
    }
}
