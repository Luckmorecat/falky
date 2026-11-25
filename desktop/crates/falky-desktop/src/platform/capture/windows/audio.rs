use std::{
    collections::VecDeque,
    mem::{ManuallyDrop, size_of},
    os::windows::io::{FromRawHandle, OwnedHandle},
    ptr, slice,
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

use windows::{
    Win32::{
        Foundation::{E_ABORT, E_UNEXPECTED, ERROR_TIMEOUT},
        Media::Audio::{
            AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED,
            AUDCLNT_E_RESOURCES_INVALIDATED, AUDCLNT_E_SERVICE_NOT_RUNNING,
            AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
            AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
            AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
            ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
            IActivateAudioInterfaceCompletionHandler,
            IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVE_FORMAT_PCM, WAVEFORMATEX,
        },
        System::{
            Com::{
                BLOB,
                StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
            },
            Threading::CreateEventW,
            Variant::VT_BLOB,
        },
    },
    core::{AgileReference, ComObject, Error, Interface, PCWSTR, Ref, Result, implement},
};

use super::{Apartment, CaptureSink, RO_INIT_MULTITHREADED, Stop};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const FRAME_BYTES: usize = CHANNELS as usize * size_of::<i16>();
const BLOCK_SAMPLES: usize = SAMPLE_RATE as usize / 100 * CHANNELS as usize;
const BLOCK_TIME: Duration = Duration::from_millis(10);
const BUFFER_SAMPLES: usize = BLOCK_SAMPLES * 10;
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(2);
const RETRY_DELAY: Duration = Duration::from_millis(250);
const MAX_ATTEMPTS: u8 = 3;

pub(super) fn start(stop: Arc<Stop>, sink: CaptureSink) -> bool {
    match thread::Builder::new()
        .name("screen-capture-audio".into())
        .spawn(move || {
            let mut clock = AudioClock {
                next: Instant::now(),
                stop: &stop,
                sink: &sink,
            };
            if let Err(error) = capture(&mut clock)
                && !stop.is_stopped()
            {
                eprintln!("Falky Windows screen-share audio unavailable: {error}");
                sink.audio_unavailable();
            }
        }) {
        Ok(_) => true,
        Err(error) => {
            eprintln!("Falky could not start Windows screen-share audio: {error}");
            false
        }
    }
}

fn capture(clock: &mut AudioClock<'_>) -> Result<()> {
    let _apartment = Apartment::new(RO_INIT_MULTITHREADED)?;
    let mut client = Loopback::open(clock, false)?;
    let mut queue = VecDeque::with_capacity(BUFFER_SAMPLES);
    let mut failures = 0;
    while clock.tick() {
        match client.fill(&mut queue) {
            Ok(()) => {
                failures = 0;
                let mut block = [0; BLOCK_SAMPLES];
                for (sample, queued) in block
                    .iter_mut()
                    .zip(queue.drain(..queue.len().min(BLOCK_SAMPLES)))
                {
                    *sample = queued;
                }
                clock.sink.stereo(&block);
            }
            Err(error) if invalidated(&error) => {
                drop(client);
                queue.clear();
                clock.silence();
                client = recover(clock, &mut failures, error)?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn invalidated(error: &Error) -> bool {
    matches!(
        error.code(),
        AUDCLNT_E_DEVICE_INVALIDATED
            | AUDCLNT_E_RESOURCES_INVALIDATED
            | AUDCLNT_E_SERVICE_NOT_RUNNING
    )
}

fn recover(clock: &mut AudioClock<'_>, failures: &mut u8, mut error: Error) -> Result<Loopback> {
    // Process loopback follows all render endpoints. Reopen it only when WASAPI invalidates the client.
    while *failures < MAX_ATTEMPTS && !clock.stop.is_stopped() {
        if *failures > 0 {
            let retry_at = Instant::now() + RETRY_DELAY;
            while Instant::now() < retry_at && clock.tick() {
                clock.silence();
            }
        }
        *failures += 1;
        match Loopback::open(clock, true) {
            Ok(client) => return Ok(client),
            Err(next_error) => error = next_error,
        }
    }
    Err(error)
}

struct AudioClock<'a> {
    next: Instant,
    stop: &'a Stop,
    sink: &'a CaptureSink,
}

impl AudioClock<'_> {
    fn tick(&mut self) -> bool {
        if self.stop.is_stopped() {
            return false;
        }
        thread::sleep(self.next.saturating_duration_since(Instant::now()));
        let now = Instant::now();
        self.next += BLOCK_TIME;
        if self.next <= now {
            self.next = now + BLOCK_TIME;
        }
        !self.stop.is_stopped()
    }

    fn silence(&self) {
        self.sink.stereo(&[0; BLOCK_SAMPLES]);
    }
}

struct Loopback {
    capture: IAudioCaptureClient,
    client: IAudioClient,
    _event: OwnedHandle,
}

impl Loopback {
    fn open(clock: &mut AudioClock<'_>, recovering: bool) -> Result<Self> {
        let client = activate(clock, recovering)?;
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: CHANNELS,
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: SAMPLE_RATE * FRAME_BYTES as u32,
            nBlockAlign: FRAME_BYTES as u16,
            wBitsPerSample: i16::BITS as u16,
            cbSize: 0,
        };

        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                0,
                0,
                &format,
                None,
            )?;
            let capture = client.GetService::<IAudioCaptureClient>()?;
            let event = CreateEventW(None, false, false, PCWSTR::null())?;
            let owned_event = OwnedHandle::from_raw_handle(event.0);
            client.SetEventHandle(event)?;
            if clock.stop.is_stopped() {
                return Err(E_ABORT.into());
            }
            client.Start()?;
            Ok(Self {
                capture,
                client,
                _event: owned_event,
            })
        }
    }

    fn fill(&self, queue: &mut VecDeque<i16>) -> Result<()> {
        // Bound each drain even if capture is producing new packets during the read.
        for _ in 0..32 {
            if unsafe { self.capture.GetNextPacketSize()? } == 0 {
                break;
            }
            let mut data = ptr::null_mut();
            let mut frames = 0;
            let mut flags = 0;
            unsafe {
                self.capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)?
            };
            if frames == 0 {
                break;
            }
            let packet = append_packet(queue, data, frames as usize, flags);
            unsafe { self.capture.ReleaseBuffer(frames)? };
            packet?;
        }
        Ok(())
    }
}

impl Drop for Loopback {
    fn drop(&mut self) {
        let _ = unsafe { self.client.Stop() };
    }
}

fn append_packet(
    queue: &mut VecDeque<i16>,
    data: *mut u8,
    frames: usize,
    flags: u32,
) -> Result<()> {
    let retained = frames.min(BUFFER_SAMPLES / CHANNELS as usize);
    let samples = retained * CHANNELS as usize;
    let discard = (queue.len() + samples).saturating_sub(BUFFER_SAMPLES);
    queue.drain(..discard);
    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
        queue.resize(queue.len() + samples, 0);
    } else if !data.is_null() {
        let packet_bytes = frames
            .checked_mul(FRAME_BYTES)
            .filter(|bytes| *bytes <= isize::MAX as usize)
            .ok_or(E_UNEXPECTED)?;
        let retained_bytes = retained * FRAME_BYTES;
        // WASAPI owns the readable packet until ReleaseBuffer. Retain only its newest complete frames.
        let bytes = unsafe {
            slice::from_raw_parts(data.add(packet_bytes - retained_bytes), retained_bytes)
        };
        let (samples, _) = bytes.as_chunks::<2>();
        queue.extend(samples.iter().copied().map(i16::from_le_bytes));
    } else {
        return Err(E_UNEXPECTED.into());
    }
    Ok(())
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Activation {
    parameters: AUDIOCLIENT_ACTIVATION_PARAMS,
    completed: mpsc::SyncSender<Result<AgileReference<IAudioClient>>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for Activation_Impl {
    fn ActivateCompleted(
        &self,
        operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> Result<()> {
        let result = (|| {
            let mut result = E_UNEXPECTED;
            let mut activated = None;
            unsafe {
                operation
                    .ok()?
                    .GetActivateResult(&mut result, &mut activated)?
            };
            result.ok()?;
            let client = activated.ok_or(E_UNEXPECTED)?.cast::<IAudioClient>()?;
            AgileReference::new(&client)
        })();
        let _ = self.completed.try_send(result);
        Ok(())
    }
}

fn activate(clock: &mut AudioClock<'_>, recovering: bool) -> Result<IAudioClient> {
    if clock.stop.is_stopped() {
        return Err(E_ABORT.into());
    }

    let (completed, result) = mpsc::sync_channel(1);
    let handler = ComObject::new(Activation {
        parameters: AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: std::process::id(),
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        },
        completed,
    });
    let props = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: ptr::from_ref(&handler.get().parameters).cast_mut().cast(),
                    },
                },
                ..Default::default()
            }),
        },
    };
    // The completion object keeps the activation blob alive even if this worker times out.
    let _operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&props),
            &*handler.as_interface::<IActivateAudioInterfaceCompletionHandler>(),
        )?
    };
    let deadline = Instant::now() + ACTIVATION_TIMEOUT;
    while Instant::now() < deadline && clock.tick() {
        if recovering {
            clock.silence();
        }
        match result.try_recv() {
            Ok(client) => return client?.resolve(),
            Err(mpsc::TryRecvError::Disconnected) => return Err(E_UNEXPECTED.into()),
            Err(mpsc::TryRecvError::Empty) => {}
        }
    }
    Err(ERROR_TIMEOUT.to_hresult().into())
}
