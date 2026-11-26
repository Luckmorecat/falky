use super::*;
use crate::perf;

#[test]
#[ignore = "release scoreboard"]
fn scoreboard_mixer() {
    let voice: [Block; 6] = std::array::from_fn(|track| std::array::from_fn(|i| signal(i, track)));
    let stereo: StereoBlock = std::array::from_fn(|i| signal(i, 12));
    let (result, levels) = perf::repeat("audio.mix_10ms", 1_001, || {
        let mut mix = Mix::default();
        let mut levels = [0.0; 6];
        for (index, (block, gain)) in std::hint::black_box(&voice)
            .iter()
            .zip([100, 75, 115, 120, 80, 100])
            .enumerate()
        {
            mix.add(block, gain);
            levels[index] = pcm_loudness(block);
        }
        mix.add_stereo(std::hint::black_box(&stereo), 85);
        (mix.finish(), levels)
    });
    let output = result
        .into_iter()
        .flat_map(i16::to_le_bytes)
        .collect::<Vec<_>>();
    let meters = levels
        .into_iter()
        .flat_map(f32::to_le_bytes)
        .collect::<Vec<_>>();
    perf::golden("audio.mix_10ms", &[&output, &meters]);
}

fn signal(sample: usize, track: usize) -> i16 {
    let sample = ((sample * 613) ^ ((track + 1) * 2077) ^ (sample * track * 7)) as i16;
    sample / 2
}
