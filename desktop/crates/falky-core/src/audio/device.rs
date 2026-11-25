use super::identity::{explicit_device, saved_id};
use super::{
    AudioDevice, AudioDevices, BLOCK_LEN, Block, RATE, SILENCE, STEREO_SILENCE, StereoBlock,
    normalize, quantize,
};
use cpal::{
    BufferSize, Device, FromSample, Host, Sample, SampleFormat, SizedSample, Stream, StreamConfig,
    StreamError, SupportedBufferSize, SupportedStreamConfig, SupportedStreamConfigRange,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use std::{
    collections::{HashSet, VecDeque},
    future::pending,
    sync::{
        Arc, Mutex,
        atomic::{
            AtomicBool, AtomicU32, AtomicU64,
            Ordering::{AcqRel, Acquire, Relaxed, Release},
        },
        mpsc::{self, RecvTimeoutError, SyncSender},
    },
    thread,
    time::Duration,
};
use tokio::sync::watch;

const DEVICE_RETRY: Duration = Duration::from_secs(2);
const QUEUE_BLOCKS: usize = 6;

struct Queue<T>(Mutex<VecDeque<T>>);

impl<T> Queue<T> {
    fn new() -> Self {
        Self(Mutex::new(VecDeque::with_capacity(QUEUE_BLOCKS)))
    }

    fn push(&self, block: T) {
        if let Ok(mut queue) = self.0.try_lock() {
            if queue.len() == QUEUE_BLOCKS {
                queue.pop_front();
            }
            queue.push_back(block);
        }
    }

    fn pop(&self) -> Option<T> {
        self.0.try_lock().ok()?.pop_front()
    }

    fn clear(&self) {
        self.0.lock().expect("audio queue lock").clear();
    }

    fn len(&self) -> usize {
        self.0.try_lock().map_or(0, |queue| queue.len())
    }
}

struct Pipes {
    capture: Queue<(u64, Block)>,
    playback: Queue<StereoBlock>,
    reference: Queue<Block>,
    capture_epoch: AtomicU64,
    render_epoch: AtomicU64,
    input_latency_ms: AtomicU32,
    output_latency_ms: AtomicU32,
}

impl Pipes {
    fn new() -> Self {
        Self {
            capture: Queue::new(),
            playback: Queue::new(),
            reference: Queue::new(),
            capture_epoch: AtomicU64::new(0),
            render_epoch: AtomicU64::new(0),
            input_latency_ms: AtomicU32::new(0),
            output_latency_ms: AtomicU32::new(0),
        }
    }

    fn flush_capture(&self) {
        self.capture_epoch.fetch_add(1, AcqRel);
        self.capture.clear();
    }

    fn pop_capture(&self) -> Option<Block> {
        while let Some((epoch, block)) = self.capture.pop() {
            if epoch == self.capture_epoch.load(Acquire) {
                return Some(block);
            }
        }
        None
    }

    fn flush_output(&self) {
        self.playback.clear();
        self.reference.clear();
        self.render_epoch.fetch_add(1, Relaxed);
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct DeviceConfig {
    pub input: Option<String>,
    pub output: Option<String>,
}

#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct DeviceStatus {
    pub devices: Arc<AudioDevices>,
    pub input_open: bool,
    pub output_open: bool,
    pub input_unavailable: bool,
    pub output_unavailable: bool,
}

type DeviceReport = (u64, DeviceStatus);

#[derive(Default)]
struct Request {
    config: DeviceConfig,
    generation: u64,
    refresh: bool,
}

pub(crate) struct AudioIo {
    pipes: Arc<Pipes>,
    request: Arc<Mutex<Request>>,
    status: watch::Receiver<DeviceReport>,
    notify: SyncSender<()>,
    generation: u64,
    running: bool,
}

impl AudioIo {
    pub fn new() -> Self {
        let (mut audio, receiver, status) = Self::channel();
        let pipes = audio.pipes.clone();
        let request = audio.request.clone();
        audio.running = thread::Builder::new()
            .name("falky-audio-devices".into())
            .spawn(move || {
                let mut devices = Devices::new(pipes);
                if let Some(devices) = &devices {
                    publish_inventory(&status, &devices.inventory);
                }
                run_requests(&request, receiver, DEVICE_RETRY, |request| {
                    let Request {
                        config,
                        generation,
                        refresh,
                    } = request;
                    let report = match &mut devices {
                        Some(devices) => {
                            if refresh {
                                devices.inventory = Arc::new(Devices::inventory(&devices.host));
                                publish_inventory(&status, &devices.inventory);
                            }
                            devices.apply(config)
                        }
                        None => DeviceStatus {
                            input_unavailable: config.input.is_some(),
                            output_unavailable: config.output.is_some(),
                            ..DeviceStatus::default()
                        },
                    };
                    publish_status(&status, generation, report);
                });
            })
            .is_ok();
        audio
    }

    fn channel() -> (Self, mpsc::Receiver<()>, watch::Sender<DeviceReport>) {
        let (status, incoming) = watch::channel((0, DeviceStatus::default()));
        let (notify, receiver) = mpsc::sync_channel(1);
        (
            Self {
                pipes: Arc::new(Pipes::new()),
                request: Arc::new(Mutex::new(Request::default())),
                status: incoming,
                notify,
                generation: 0,
                running: true,
            },
            receiver,
            status,
        )
    }

    #[cfg(test)]
    pub fn test_channel() -> (Self, mpsc::Receiver<()>, watch::Sender<DeviceReport>) {
        Self::channel()
    }

    pub fn configure(&mut self, config: DeviceConfig) {
        let mut request = self.request.lock().expect("audio request lock");
        if request.config != config {
            if request.config.input != config.input {
                self.pipes.flush_capture();
            }
            if request.config.output != config.output {
                self.pipes.flush_output();
            }
            request.config = config;
            request.generation += 1;
            self.generation = request.generation;
            let _ = self.notify.try_send(());
        }
    }

    pub fn refresh(&self) {
        let mut request = self.request.lock().expect("audio request lock");
        request.refresh = true;
        let _ = self.notify.try_send(());
    }

    pub async fn status_changed(&mut self) {
        if !self.running {
            return pending().await;
        }
        // Drain the last unseen report before marking a closed worker unavailable.
        if self.status.changed().await.is_err() {
            self.running = false;
        }
    }

    pub fn status(&self) -> DeviceStatus {
        let (generation, status) = &*self.status.borrow();
        if !self.running {
            return DeviceStatus {
                devices: status.devices.clone(),
                input_unavailable: true,
                output_unavailable: true,
                ..DeviceStatus::default()
            };
        }
        if *generation == self.generation {
            status.clone()
        } else {
            DeviceStatus {
                devices: status.devices.clone(),
                ..DeviceStatus::default()
            }
        }
    }

    pub fn capture(&self) -> Option<Block> {
        self.pipes.pop_capture()
    }

    pub fn output(&self, block: StereoBlock) {
        self.pipes.playback.push(block);
    }

    pub fn reference(&self) -> Option<Block> {
        self.pipes.reference.pop()
    }

    pub fn reset_input(&self) {
        self.pipes.flush_capture();
    }

    pub fn reset_output(&self) {
        self.pipes.flush_output();
    }

    pub fn stream_delay_ms(&self) -> i32 {
        let device =
            self.pipes.input_latency_ms.load(Relaxed) + self.pipes.output_latency_ms.load(Relaxed);
        let queued = (self.pipes.capture.len() + self.pipes.reference.len()) as u32 * 10;
        (device + queued).clamp(0, 500) as i32
    }
}

fn run_requests(
    request: &Mutex<Request>,
    receiver: mpsc::Receiver<()>,
    retry: Duration,
    mut apply: impl FnMut(Request),
) {
    loop {
        let next = {
            let mut request = request.lock().expect("audio request lock");
            // Anything already queued is covered by this snapshot. Later commands
            // enqueue a new wake under the same lock.
            if receiver.try_recv() == Err(mpsc::TryRecvError::Disconnected) {
                break;
            }
            Request {
                config: request.config.clone(),
                generation: request.generation,
                refresh: std::mem::take(&mut request.refresh),
            }
        };
        let requested = next.config.input.is_some() || next.config.output.is_some();
        apply(next);
        let disconnected = if requested {
            receiver.recv_timeout(retry) == Err(RecvTimeoutError::Disconnected)
        } else {
            receiver.recv().is_err()
        };
        if disconnected {
            break;
        }
    }
}

fn publish_inventory(status: &watch::Sender<DeviceReport>, inventory: &Arc<AudioDevices>) {
    status.send_if_modified(|(_, report)| {
        if report.devices == *inventory {
            return false;
        }
        report.devices = inventory.clone();
        true
    });
}

fn publish_status(status: &watch::Sender<DeviceReport>, generation: u64, report: DeviceStatus) {
    let next = (generation, report);
    status.send_if_modified(|previous| {
        if *previous == next {
            return false;
        }
        *previous = next;
        true
    });
}

#[derive(Clone, Copy)]
enum Direction {
    Input,
    Output,
}

impl Direction {
    fn default_device(self, host: &Host) -> Option<Device> {
        match self {
            Self::Input => host.default_input_device(),
            Self::Output => host.default_output_device(),
        }
    }

    fn default_config(self, device: &Device) -> Option<SupportedStreamConfig> {
        match self {
            Self::Input => device.default_input_config().ok(),
            Self::Output => device.default_output_config().ok(),
        }
    }

    fn preferred_config(self, device: &Device) -> Option<SupportedStreamConfig> {
        let default = self.default_config(device);
        let candidates: Vec<_> = match self {
            Self::Input => device
                .supported_input_configs()
                .ok()
                .into_iter()
                .flatten()
                .collect(),
            Self::Output => device
                .supported_output_configs()
                .ok()
                .into_iter()
                .flatten()
                .collect(),
        };
        choose_pcm_config(
            default,
            candidates,
            if matches!(self, Self::Output) { 2 } else { 1 },
        )
    }

    fn inventory(self, host: &Host) -> Vec<AudioDevice> {
        let mut devices = host
            .devices()
            .into_iter()
            .flatten()
            .filter_map(|device| {
                let id = saved_id(&device.id().ok()?)?;
                self.default_config(&device)?;
                let name = device.description().ok()?.name().to_owned();
                Some(AudioDevice { id, name })
            })
            .collect::<Vec<_>>();
        devices.sort_by(|first, next| first.name.cmp(&next.name).then(first.id.cmp(&next.id)));
        let mut identities = HashSet::new();
        devices.retain(|device| identities.insert(device.id.clone()));
        for same_name in devices.chunk_by_mut(|first, next| first.name == next.name) {
            for (index, device) in same_name.iter_mut().enumerate().skip(1) {
                device.name = format!("{} ({})", device.name, index + 1);
            }
        }
        devices
    }
}

fn pcm_format(format: SampleFormat) -> bool {
    format.is_int() || format.is_uint() || format.is_float()
}

fn choose_pcm_config(
    default: Option<SupportedStreamConfig>,
    candidates: impl IntoIterator<Item = SupportedStreamConfigRange>,
    channels: u16,
) -> Option<SupportedStreamConfig> {
    let default = default.filter(|config| pcm_format(config.sample_format()));
    let preferred = candidates
        .into_iter()
        .filter(|config| pcm_format(config.sample_format()))
        .map(|config| {
            config.with_sample_rate(RATE.clamp(config.min_sample_rate(), config.max_sample_rate()))
        })
        .min_by_key(|config| {
            (
                channels == 2 && config.channels() < 2,
                config.sample_rate().abs_diff(RATE),
                config.channels() != channels,
                default
                    .as_ref()
                    .is_some_and(|native| config.channels() != native.channels()),
                default
                    .as_ref()
                    .is_some_and(|native| config.sample_format() != native.sample_format()),
            )
        });
    // Keep the native format when it needs resampling unless doing so loses stereo.
    preferred
        .filter(|config| {
            config.sample_rate() == RATE
                || default.as_ref().is_none_or(|native| {
                    channels == 2 && native.channels() < 2 && config.channels() >= 2
                })
        })
        .or(default)
}

struct OpenStream {
    stream: Stream,
    state: Arc<StreamState>,
}

#[derive(Default)]
struct StreamState {
    ready: AtomicBool,
    failed: AtomicBool,
}

impl StreamState {
    fn capture(&self, read: impl FnOnce()) {
        if self.ready.load(Acquire) {
            read();
        }
    }

    fn render<T: Sample>(&self, data: &mut [T], write: impl FnOnce(&mut [T])) {
        if self.ready.load(Acquire) {
            write(data);
        } else {
            data.fill(T::EQUILIBRIUM);
        }
    }

    fn error(&self, error: StreamError) {
        if !matches!(error, StreamError::BufferUnderrun) {
            self.failed.store(true, Relaxed);
        }
    }
}

struct Devices {
    host: Host,
    inventory: Arc<AudioDevices>,
    input: Option<OpenStream>,
    output: Option<OpenStream>,
    config: DeviceConfig,
    pipes: Arc<Pipes>,
}

impl Devices {
    fn new(pipes: Arc<Pipes>) -> Option<Self> {
        #[cfg(target_os = "linux")]
        let host = cpal::host_from_id(cpal::HostId::Alsa).ok()?;
        #[cfg(not(target_os = "linux"))]
        let host = cpal::default_host();
        let inventory = Arc::new(Self::inventory(&host));
        Some(Self {
            host,
            inventory,
            input: None,
            output: None,
            config: DeviceConfig::default(),
            pipes,
        })
    }

    fn inventory(host: &Host) -> AudioDevices {
        AudioDevices {
            input: Direction::Input.inventory(host),
            output: Direction::Output.inventory(host),
        }
    }

    fn apply(&mut self, config: DeviceConfig) -> DeviceStatus {
        if self.config.input != config.input || stream_failed(&self.input) {
            self.input = None;
            self.pipes.flush_capture();
        }
        if self.config.output != config.output || stream_failed(&self.output) {
            self.output = None;
            self.pipes.flush_output();
        }
        self.config = config;
        if let Some(id) = &self.config.input
            && self.input.is_none()
        {
            self.input = self.open(Direction::Input, id);
        }
        if let Some(id) = &self.config.output
            && self.output.is_none()
        {
            self.output = self.open(Direction::Output, id);
        }
        DeviceStatus {
            devices: self.inventory.clone(),
            input_open: self.input.is_some(),
            output_open: self.output.is_some(),
            input_unavailable: self.config.input.is_some() && self.input.is_none(),
            output_unavailable: self.config.output.is_some() && self.output.is_none(),
        }
    }

    fn open(&self, direction: Direction, selected: &str) -> Option<OpenStream> {
        let device = if selected.is_empty() {
            direction.default_device(&self.host)?
        } else {
            explicit_device(&self.host, selected)?
        };
        let opened = self.open_device(direction, &device);
        // ALSA can start callbacks and reassign a card during stream creation.
        let opened = opened.filter(|_| {
            selected.is_empty()
                || device.id().ok().as_ref().and_then(saved_id).as_deref() == Some(selected)
        });
        if let Some(opened) = &opened {
            opened.state.ready.store(true, Release);
        } else if !selected.is_empty() {
            // Drop any rejected stream before discarding its buffered audio.
            match direction {
                Direction::Input => self.pipes.flush_capture(),
                Direction::Output => self.pipes.flush_output(),
            }
        }
        opened
    }

    fn open_device(&self, direction: Direction, device: &Device) -> Option<OpenStream> {
        let config = direction.preferred_config(device)?;
        let mut format = config.config();
        if let SupportedBufferSize::Range { min, max } = *config.buffer_size() {
            format.buffer_size = BufferSize::Fixed((config.sample_rate() / 25).clamp(min, max));
        }
        let build_stream = |format: &StreamConfig| {
            let state = Arc::new(StreamState::default());
            let stream = build(
                direction,
                device,
                config.sample_format(),
                format,
                self.pipes.clone(),
                state.clone(),
            )?;
            Some(OpenStream { stream, state })
        };
        let opened = build_stream(&format).or_else(|| {
            (format.buffer_size != BufferSize::Default)
                .then(|| build_stream(&config.config()))
                .flatten()
        })?;
        opened.stream.play().ok()?;
        Some(opened)
    }
}

fn stream_failed(stream: &Option<OpenStream>) -> bool {
    stream
        .as_ref()
        .is_some_and(|open| open.state.failed.load(Relaxed))
}

fn build(
    direction: Direction,
    device: &Device,
    sample_format: SampleFormat,
    config: &StreamConfig,
    pipes: Arc<Pipes>,
    state: Arc<StreamState>,
) -> Option<Stream> {
    macro_rules! typed {
        ($sample:ty) => {
            match direction {
                Direction::Input => input::<$sample>(device, config, pipes, state),
                Direction::Output => output::<$sample>(device, config, pipes, state),
            }
        };
    }
    match sample_format {
        SampleFormat::I8 => typed!(i8),
        SampleFormat::I16 => typed!(i16),
        SampleFormat::I24 => typed!(cpal::I24),
        SampleFormat::I32 => typed!(i32),
        SampleFormat::I64 => typed!(i64),
        SampleFormat::U8 => typed!(u8),
        SampleFormat::U16 => typed!(u16),
        SampleFormat::U24 => typed!(cpal::U24),
        SampleFormat::U32 => typed!(u32),
        SampleFormat::U64 => typed!(u64),
        SampleFormat::F32 => typed!(f32),
        SampleFormat::F64 => typed!(f64),
        _ => None,
    }
}

struct Pack {
    block: Block,
    offset: usize,
}

impl Pack {
    fn new() -> Self {
        Self {
            block: SILENCE,
            offset: 0,
        }
    }

    fn add(&mut self, sample: f32) -> Option<Block> {
        self.block[self.offset] = quantize(sample);
        self.offset += 1;
        if self.offset == BLOCK_LEN {
            self.offset = 0;
            Some(self.block)
        } else {
            None
        }
    }
}

// Linear interpolation with a phase carried across callbacks. Keeping the canonical clock
// independent of the platform sample rate also handles 44.1 kHz host defaults.
struct Resampler {
    before: Option<f32>,
    next: u64,
    input_rate: u64,
    output_rate: u64,
}

impl Resampler {
    fn new(input_rate: u32, output_rate: u32) -> Self {
        Self {
            before: None,
            next: 0,
            input_rate: input_rate.into(),
            output_rate: output_rate.into(),
        }
    }

    fn push(&mut self, value: f32, mut emit: impl FnMut(f32)) {
        if let Some(before) = self.before.replace(value) {
            while self.next < self.output_rate {
                let fraction = self.next as f32 / self.output_rate as f32;
                emit(before + (value - before) * fraction);
                self.next += self.input_rate;
            }
            self.next -= self.output_rate;
        }
    }
}

fn input<T>(
    device: &Device,
    config: &StreamConfig,
    pipes: Arc<Pipes>,
    state: Arc<StreamState>,
) -> Option<Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let rate = config.sample_rate;
    let channels = usize::from(config.channels);
    let mut block = Pack::new();
    let mut resample = Resampler::new(rate, RATE);
    let mut epoch = pipes.capture_epoch.load(Acquire);
    let callbacks = state.clone();
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data, info| {
                callbacks.capture(|| {
                    let current = pipes.capture_epoch.load(Acquire);
                    let time = info.timestamp();
                    let latency = time.callback.duration_since(&time.capture);
                    pipes.input_latency_ms.store(ms(latency), Relaxed);
                    if current != epoch {
                        block = Pack::new();
                        resample = Resampler::new(rate, RATE);
                        epoch = current;
                        // The device can deliver buffered samples from before the reset.
                        return;
                    }
                    for samples in data.chunks_exact(channels) {
                        let sum: f32 = samples.iter().copied().map(Sample::to_sample::<f32>).sum();
                        let mono = sum / channels as f32;
                        let mono = if mono.is_finite() {
                            mono.clamp(-1.0, 1.0)
                        } else {
                            0.0
                        };
                        resample.push(mono, |sample| {
                            if let Some(complete) = block.add(sample) {
                                pipes.capture.push((current, complete));
                            }
                        });
                    }
                })
            },
            move |error| state.error(error),
            None,
        )
        .ok()
}

fn output<T>(
    device: &Device,
    config: &StreamConfig,
    pipes: Arc<Pipes>,
    state: Arc<StreamState>,
) -> Option<Stream>
where
    T: SizedSample + FromSample<f32>,
    f32: FromSample<T>,
{
    let rate = config.sample_rate;
    let channels = usize::from(config.channels);
    let mut renderer = Renderer::new(rate);
    let mut reference = Pack::new();
    let mut resample = Resampler::new(rate, RATE);
    let mut epoch = pipes.render_epoch.load(Relaxed);
    let callbacks = state.clone();
    device
        .build_output_stream::<T, _, _>(
            config,
            move |data, info| {
                callbacks.render(data, |data| {
                    let time = info.timestamp();
                    let latency = time.playback.duration_since(&time.callback);
                    pipes.output_latency_ms.store(ms(latency), Relaxed);
                    let current = pipes.render_epoch.load(Relaxed);
                    if epoch != current {
                        renderer = Renderer::new(rate);
                        reference = Pack::new();
                        resample = Resampler::new(rate, RATE);
                        epoch = current;
                    }
                    for frame in data.chunks_exact_mut(channels) {
                        let rendered = render_pair(frame, renderer.next(&pipes.playback));
                        resample.push(rendered, |sample| {
                            if let Some(complete) = reference.add(sample) {
                                pipes.reference.push(complete);
                            }
                        });
                    }
                })
            },
            move |error| state.error(error),
            None,
        )
        .ok()
}

fn render_pair<T>(frame: &mut [T], [left, right]: [f32; 2]) -> f32
where
    T: Sample + FromSample<f32>,
    f32: FromSample<T>,
{
    if let [mono] = frame {
        *mono = T::from_sample((left + right) * 0.5);
        mono.to_sample::<f32>()
    } else {
        frame[0] = T::from_sample(left);
        frame[1] = T::from_sample(right);
        frame[2..].fill(T::EQUILIBRIUM);
        (frame[0].to_sample::<f32>() + frame[1].to_sample::<f32>()) * 0.5
    }
}

fn ms(duration: Option<Duration>) -> u32 {
    duration.map_or(0, |value| value.as_millis().min(500) as u32)
}

struct Renderer {
    block: StereoBlock,
    offset: usize,
    phase: u64,
    before: [f32; 2],
    after: [f32; 2],
    rate: u64,
}

impl Renderer {
    fn new(rate: u32) -> Self {
        Self {
            block: STEREO_SILENCE,
            offset: BLOCK_LEN * 2,
            phase: rate.into(),
            before: [0.0; 2],
            after: [0.0; 2],
            rate: rate.into(),
        }
    }

    fn next(&mut self, queue: &Queue<StereoBlock>) -> [f32; 2] {
        while self.phase >= self.rate {
            if self.offset == self.block.len() {
                self.block = queue.pop().unwrap_or(STEREO_SILENCE);
                self.offset = 0;
            }
            self.before = self.after;
            self.after = [
                normalize(self.block[self.offset]),
                normalize(self.block[self.offset + 1]),
            ];
            self.offset += 2;
            self.phase -= self.rate;
        }
        let fraction = self.phase as f32 / self.rate as f32;
        let sample = std::array::from_fn(|channel| {
            self.before[channel] + (self.after[channel] - self.before[channel]) * fraction
        });
        self.phase += RATE as u64;
        sample
    }
}

#[cfg(test)]
impl AudioIo {
    pub fn test_failed_worker_start() -> Self {
        let (mut audio, _, _) = Self::channel();
        audio.running = false;
        audio
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_keeps_inventory_and_reports_the_current_generation_before_closure() {
        let (mut audio, _commands, status) = AudioIo::channel();
        let devices = Arc::new(AudioDevices {
            input: vec![AudioDevice {
                id: "mic".into(),
                name: "Microphone".into(),
            }],
            output: Vec::new(),
        });
        let opened = DeviceStatus {
            devices: devices.clone(),
            input_open: true,
            ..DeviceStatus::default()
        };

        audio.configure(DeviceConfig {
            input: Some("mic".into()),
            output: None,
        });
        status.send_replace((1, opened.clone()));
        assert!(audio.status().input_open);
        audio.status_changed().await;

        audio.configure(DeviceConfig {
            input: Some("other".into()),
            output: None,
        });
        let pending = audio.status();
        assert_eq!(pending.devices, devices);
        assert!(!pending.input_open && !pending.input_unavailable);

        publish_status(&status, 2, opened.clone());
        publish_status(&status, 2, opened);
        drop(status);
        audio.status_changed().await;
        assert!(audio.status().input_open);
        audio.status_changed().await;
        let stopped = audio.status();
        assert_eq!(stopped.devices, devices);
        assert!(!stopped.input_open && stopped.input_unavailable);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), audio.status_changed())
                .await
                .is_err()
        );
    }

    #[test]
    fn device_requests_coalesce_and_only_requested_routes_retry() {
        let (mut audio, commands, _status) = AudioIo::channel();
        let request = audio.request.clone();
        let (report, applied) = mpsc::channel();
        let (resume, paused) = mpsc::sync_channel(0);
        let worker = thread::spawn(move || {
            run_requests(&request, commands, Duration::from_millis(10), |request| {
                report.send(request).unwrap();
                paused.recv().unwrap();
            });
        });
        let applied_request = || applied.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(applied_request().generation, 0);

        let config = |id: &str| DeviceConfig {
            input: Some(id.into()),
            output: None,
        };
        audio.configure(config("first"));
        audio.refresh();
        audio.configure(config("second"));
        audio.refresh();
        resume.send(()).unwrap();
        let latest = applied_request();
        assert_eq!(latest.generation, 2);
        assert_eq!(latest.config, config("second"));
        assert!(latest.refresh);

        resume.send(()).unwrap();
        let retry = applied_request();
        assert_eq!(retry.config, latest.config);
        assert!(!retry.refresh);

        audio.configure(DeviceConfig::default());
        resume.send(()).unwrap();
        assert_eq!(applied_request().config, DeviceConfig::default());
        resume.send(()).unwrap();
        assert!(matches!(
            applied.recv_timeout(Duration::from_millis(50)),
            Err(RecvTimeoutError::Timeout)
        ));

        drop(audio);
        worker.join().unwrap();
    }

    #[test]
    fn playback_prefers_stereo_even_when_the_device_only_offers_it_at_44_1_khz() {
        let config = |channels, rate| {
            SupportedStreamConfigRange::new(
                channels,
                rate,
                rate,
                SupportedBufferSize::Unknown,
                SampleFormat::I16,
            )
        };
        let mono = config(1, RATE);
        let stereo = config(2, 44_100);
        let selected =
            choose_pcm_config(Some(mono.with_sample_rate(RATE)), [mono, stereo], 2).unwrap();
        assert_eq!((selected.channels(), selected.sample_rate()), (2, 44_100));
        let selected =
            choose_pcm_config(Some(mono.with_sample_rate(RATE)), [mono, stereo], 1).unwrap();
        assert_eq!((selected.channels(), selected.sample_rate()), (1, RATE));
    }

    #[test]
    fn stream_configuration_prefers_only_viable_pcm() {
        let config = |rate, format| {
            SupportedStreamConfigRange::new(1, rate, rate, SupportedBufferSize::Unknown, format)
        };
        let unsupported = config(RATE, SampleFormat::DsdU8);
        let canonical = config(RATE, SampleFormat::U24);
        let fallback = config(44_100, SampleFormat::I16);
        let choose = |candidates| {
            choose_pcm_config(Some(unsupported.with_sample_rate(RATE)), candidates, 1).unwrap()
        };
        assert_eq!(
            choose([unsupported, canonical]).sample_format(),
            SampleFormat::U24
        );
        assert_eq!(choose([unsupported, fallback]).sample_rate(), 44_100);
        assert!(
            choose_pcm_config(Some(unsupported.with_sample_rate(RATE)), [unsupported], 1).is_none()
        );
    }

    #[test]
    fn audio_callbacks_stay_silent_until_stream_validation() {
        let state = StreamState::default();
        let mut captured = false;
        let mut rendered = [0_u16];
        state.capture(|| captured = true);
        state.render(&mut rendered, |data| data[0] = 1);
        assert!(!captured);
        assert_eq!(rendered, [u16::EQUILIBRIUM]);

        state.ready.store(true, Release);
        state.capture(|| captured = true);
        state.render(&mut rendered, |data| data[0] = 1);
        assert!(captured);
        assert_eq!(rendered, [1]);

        state.error(StreamError::BufferUnderrun);
        assert!(!state.failed.load(Relaxed));
        state.error(StreamError::DeviceNotAvailable);
        assert!(state.failed.load(Relaxed));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn malformed_alsa_config_reports_unavailable_audio() {
        use std::{env, fs, process::Command, time::Instant};

        const CHILD: &str = "FALKY_TEST_MALFORMED_ALSA_CONFIG";
        if env::var_os(CHILD).is_none() {
            let fixture = tempfile::tempdir().unwrap();
            let config = fixture.path().join("asound.conf");
            fs::write(&config, "pcm.!default {").unwrap();
            // ALSA's configuration cache is process-global.
            let output = Command::new(env::current_exe().unwrap())
                .args([
                    "--exact",
                    "audio::device::tests::malformed_alsa_config_reports_unavailable_audio",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env("ALSA_CONFIG_PATH", config)
                .output()
                .unwrap();
            assert!(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("1 passed")
                    && !String::from_utf8_lossy(&output.stderr).contains("panicked"),
                "isolated ALSA fixture failed: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            return;
        }

        let mut audio = AudioIo::new();
        for (input, output) in [(true, false), (false, true)] {
            audio.configure(DeviceConfig {
                input: input.then(String::new),
                output: output.then(String::new),
            });
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let status = audio.status();
                assert!(!status.input_open && !status.output_open);
                assert!(status.devices.input.is_empty() && status.devices.output.is_empty());
                assert!(audio.capture().is_none());
                if (status.input_unavailable, status.output_unavailable) == (input, output) {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "worker did not report unavailable audio"
                );
                thread::sleep(Duration::from_millis(5));
            }
        }
    }

    #[test]
    fn capture_drops_blocks_from_callbacks_in_flight_during_reset() {
        let pipes = Pipes::new();
        let acquired = pipes.capture_epoch.load(Acquire);
        pipes.capture.push((acquired, [1; BLOCK_LEN]));
        pipes.flush_capture();
        pipes.capture.push((acquired, [2; BLOCK_LEN]));
        pipes
            .capture
            .push((pipes.capture_epoch.load(Acquire), [3; BLOCK_LEN]));

        assert_eq!(pipes.pop_capture(), Some([3; BLOCK_LEN]));
        assert_eq!(pipes.pop_capture(), None);
    }

    #[test]
    fn queue_drops_oldest_and_flushes_on_device_changes() {
        let queue = Queue::new();
        for index in 0..10 {
            queue.push([index; BLOCK_LEN]);
        }
        assert_eq!(queue.len(), QUEUE_BLOCKS);
        assert_eq!(queue.pop().unwrap()[0], 4);
        queue.clear();
        assert!(queue.pop().is_none());
    }

    #[test]
    fn resampling_keeps_phase_across_variable_device_callback_sizes() {
        for rate in [16_000, 44_100, 48_000, 96_000] {
            let mut resampler = Resampler::new(rate, RATE);
            let queue = Queue::new();
            let mut pack = Pack::new();
            for _ in 0..=rate / 100 {
                resampler.push(0.25, |sample| {
                    if let Some(complete) = pack.add(sample) {
                        queue.push(complete);
                    }
                });
            }
            assert_eq!(queue.pop(), Some([8192; BLOCK_LEN]));
            assert!(queue.pop().is_none());
        }
    }

    #[test]
    fn render_fills_underruns_with_silence() {
        let queue = Queue::new();
        queue.push(std::array::from_fn(|index| {
            if index % 2 == 0 { 8192 } else { -4096 }
        }));
        let mut renderer = Renderer::new(48_000);
        assert_eq!(renderer.next(&queue), [0.0; 2]);
        for _ in 0..BLOCK_LEN {
            assert_eq!(renderer.next(&queue), [0.25, -0.125]);
        }
        assert_eq!(renderer.next(&queue), [0.0; 2]);
    }

    #[test]
    fn apm_reference_downmixes_rendered_left_and_right() {
        let mut stereo = [0i16; 2];
        let mut mono = [0i16; 1];
        assert_eq!(render_pair(&mut stereo, [0.5, -0.25]), 0.125);
        assert_eq!(stereo, [16384, -8192]);
        assert_eq!(render_pair(&mut mono, [0.5, -0.25]), 0.125);
        assert_eq!(mono, [4096]);
    }
}
