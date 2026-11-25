mod frames;
mod sck;

use std::{
    cell::RefCell,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchTime};
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, Message, define_class, msg_send,
    rc::Retained,
    runtime::{NSObject, NSObjectProtocol, ProtocolObject},
};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::kCVPixelFormatType_32BGRA;
use objc2_foundation::{NSError, NSNumber};
use raw_window_handle::{RawDisplayHandle, RawWindowHandle};
use tokio::sync::oneshot;

use super::{Availability, CaptureError, CaptureOptions, CaptureSink, CaptureStart};
use frames::{ScreenSample, Size};
use sck::{
    PickerObserver as PickerObserverProtocol, StreamDelegate, StreamOutput as StreamOutputProtocol,
};

pub(super) fn available() -> Availability {
    let video = sck::framework().is_some();
    Availability {
        video,
        audio: video && sck::audio_available(),
    }
}

pub(super) fn begin(
    window: RawWindowHandle,
    _display: Option<RawDisplayHandle>,
    options: CaptureOptions,
    sink: CaptureSink,
) -> CaptureStart {
    let availability = available();
    let Some(main) = MainThreadMarker::new()
        .filter(|_| availability.video && matches!(window, RawWindowHandle::AppKit(_)))
    else {
        return Box::pin(async { Err(CaptureError::Unavailable) });
    };
    let (response, result) = oneshot::channel();
    let request = Arc::new(Request::default());
    let picker = STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.clear_cancelled();
        if state.current.is_some() {
            return None;
        }

        let observer = PickerObserver::new(Arc::clone(&request));
        let picker = sck::Picker::shared(main);
        let configuration = sck::PickerConfiguration::new();
        configuration.set_allowed_modes(sck::SINGLE_WINDOW | sck::SINGLE_DISPLAY);
        configuration.allow_source_changes(false);
        picker.configure(&configuration);
        picker.set_maximum_stream_count(&NSNumber::new_usize(1));
        picker.add_observer(ProtocolObject::from_ref(&*observer));

        state.current = Some(Session {
            request: Arc::clone(&request),
            picker: picker.clone(),
            observer: Some(observer),
            response: Some(response),
            options,
            sink,
            audio_available: availability.audio,
            stream: None,
        });
        Some(picker)
    });
    let Some(picker) = picker else {
        return Box::pin(async { Err(CaptureError::Failed) });
    };
    picker.set_active(true);
    picker.present();

    let guard = CaptureGuard(request);
    Box::pin(async move {
        match result.await.unwrap_or(Err(CaptureError::Failed))? {
            true => Ok(Some(Box::new(guard) as Box<dyn Send>)),
            false => Ok(None),
        }
    })
}

thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State {
        current: None,
        retiring: Vec::new(),
    }) };
}

#[derive(Default)]
struct Request {
    cancelled: AtomicBool,
}

struct CaptureGuard(Arc<Request>);

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
        on_main(State::clear_cancelled);
    }
}

fn on_main(change: impl FnOnce(&mut State) + Send + 'static) {
    DispatchQueue::main().exec_async(move || STATE.with(|state| change(&mut state.borrow_mut())));
}

struct State {
    current: Option<Session>,
    retiring: Vec<NativeStream>,
}

impl State {
    fn clear_cancelled(&mut self) {
        if self
            .current
            .as_ref()
            .is_some_and(|session| session.request.cancelled.load(Ordering::Acquire))
        {
            self.close(None);
        }
    }

    fn close(&mut self, result: Option<Result<bool, CaptureError>>) {
        let Some(mut session) = self.current.take() else {
            return;
        };
        session.remove_observer();
        session.picker.set_active(false);
        if let Some(result) = result
            && let Some(response) = session.response.take()
        {
            let _ = response.send(result);
        }

        if let Some(stream) = session.stream.take() {
            self.retire(stream);
        }
    }

    fn retire(&mut self, stream: NativeStream) {
        stream.attempt.live.store(false, Ordering::Release);
        match stream.phase {
            Phase::Starting { .. } => self.retiring.push(stream),
            Phase::Live => {
                stream.stop();
                self.retiring.push(stream);
            }
            Phase::Ended => {}
        }
    }

    fn picker_outcome(&mut self, request: &Arc<Request>, result: PickerOutcome) {
        self.clear_cancelled();
        let Some(session) = self
            .current
            .as_mut()
            .filter(|session| Arc::ptr_eq(&session.request, request) && session.observer.is_some())
        else {
            return;
        };
        match result {
            PickerOutcome::Cancelled => self.close(Some(Ok(false))),
            PickerOutcome::Failed(error) => self.close(Some(Err(error))),
            PickerOutcome::Selected(filter) => {
                session.remove_observer();
                if let Err(error) = session.start(
                    filter.into_inner(),
                    session.options.with_audio && session.audio_available,
                ) {
                    self.close(Some(Err(error)));
                }
            }
        }
    }

    fn start_finished(&mut self, attempt: &Arc<Attempt>, outcome: Result<(), StartFailure>) {
        self.clear_cancelled();
        let Some(session) = self
            .current
            .as_mut()
            .filter(|session| session.owns(attempt))
        else {
            if let Some(index) = self.retiring.iter().position(|stream| stream.owns(attempt)) {
                let mut stream = self.retiring.swap_remove(index);
                if outcome.is_ok() && matches!(stream.phase, Phase::Starting { stopped: false, .. })
                {
                    stream.phase = Phase::Live;
                    self.retire(stream);
                }
            }
            return;
        };
        let Some(stream) = session.stream.as_mut() else {
            return;
        };
        let Phase::Starting { lost, stopped } = stream.phase else {
            return;
        };
        stream.phase = if outcome.is_ok() && !stopped {
            Phase::Live
        } else {
            Phase::Ended
        };
        let Err(error) = lost.map_or(outcome, Err) else {
            stream.attempt.live.store(true, Ordering::Release);
            if session.options.with_audio && !stream.with_audio {
                session.sink.audio_unavailable();
            }
            if let Some(response) = session.response.take()
                && response.send(Ok(true)).is_err()
            {
                self.close(None);
            }
            return;
        };

        if matches!(error, StartFailure::Audio) && stream.with_audio {
            let stream = session.stream.take().expect("starting stream");
            let result = session.start(stream.filter.clone(), false);
            self.retire(stream);
            if let Err(error) = result {
                self.close(Some(Err(error)));
            }
        } else {
            self.close(Some(Err(error.capture_error())));
        }
    }

    fn source_ended(&mut self, attempt: &Arc<Attempt>, error: StartFailure, stopped: bool) {
        self.clear_cancelled();
        if let Some(session) = self
            .current
            .as_mut()
            .filter(|session| session.owns(attempt))
            && let Some(stream) = session.stream.as_mut()
        {
            match &mut stream.phase {
                Phase::Starting {
                    lost,
                    stopped: ended,
                } => {
                    lost.get_or_insert(error);
                    *ended |= stopped;
                }
                Phase::Live => {
                    if stopped {
                        stream.phase = Phase::Ended;
                    }
                    session.sink.source_lost();
                    self.close(None);
                }
                Phase::Ended => {}
            }
        } else if stopped
            && let Some(stream) = self.retiring.iter_mut().find(|stream| stream.owns(attempt))
        {
            stream.phase = Phase::Ended;
        }
    }

    fn resize(&mut self, attempt: &Arc<Attempt>) {
        if let Some((stream, options)) = self.resizing_stream(attempt) {
            stream.resize(options);
        }
    }

    fn resize_finished(&mut self, attempt: &Arc<Attempt>, size: Size, succeeded: bool) {
        let Some((stream, options)) = self.resizing_stream(attempt) else {
            return;
        };
        if succeeded {
            stream.configured_size = size;
            stream.resize_failure = None;
            stream.resizing = false;
            stream.resize(options);
            return;
        }

        let retried = stream
            .resize_failure
            .is_some_and(|failure| failure.size == size);
        stream.resize_failure = Some(ResizeFailure { size, retried });
        let attempt = Arc::clone(attempt);
        let retry_at =
            DispatchTime::try_from(Duration::from_millis(250)).expect("fixed resize delay");
        // Keep requests serialized during the delay, then use the latest size.
        if DispatchQueue::main()
            .after(retry_at, move || {
                STATE.with(|state| state.borrow_mut().resume_resize(&attempt));
            })
            .is_err()
        {
            stream.resizing = false;
        }
    }

    fn resume_resize(&mut self, attempt: &Arc<Attempt>) {
        if let Some((stream, options)) = self.resizing_stream(attempt) {
            stream.resizing = false;
            stream.resize(options);
        }
    }

    fn resizing_stream(
        &mut self,
        attempt: &Arc<Attempt>,
    ) -> Option<(&mut NativeStream, CaptureOptions)> {
        self.clear_cancelled();
        let session = self
            .current
            .as_mut()
            .filter(|session| session.owns(attempt))?;
        Some((session.stream.as_mut()?, session.options))
    }
}

struct Session {
    request: Arc<Request>,
    picker: Retained<sck::Picker>,
    observer: Option<Retained<PickerObserver>>,
    response: Option<oneshot::Sender<Result<bool, CaptureError>>>,
    options: CaptureOptions,
    sink: CaptureSink,
    audio_available: bool,
    stream: Option<NativeStream>,
}

impl Session {
    fn remove_observer(&mut self) {
        if let Some(observer) = self.observer.take() {
            self.picker
                .remove_observer(ProtocolObject::from_ref(&*observer));
        }
    }

    fn owns(&self, attempt: &Arc<Attempt>) -> bool {
        self.stream
            .as_ref()
            .is_some_and(|stream| stream.owns(attempt))
    }

    fn start(
        &mut self,
        filter: Retained<sck::Filter>,
        with_audio: bool,
    ) -> Result<(), CaptureError> {
        let bounds = filter.content_rect().size;
        let scale = f64::from(filter.point_pixel_scale());
        let size = Size::fit(bounds.width * scale, bounds.height * scale, self.options)
            .ok_or(CaptureError::Failed)?;
        let create = |with_audio| {
            NativeStream::new(
                Arc::clone(&self.request),
                &filter,
                size,
                self.options,
                self.sink.clone(),
                with_audio,
            )
        };
        let stream = match create(with_audio) {
            Err(StartFailure::Audio) if with_audio => create(false),
            result => result,
        }
        .map_err(StartFailure::capture_error)?;
        if self.request.cancelled.load(Ordering::Acquire) {
            return Err(CaptureError::Failed);
        }
        stream.start();
        self.stream = Some(stream);
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum StartFailure {
    Audio,
    Capture(CaptureError),
}

impl StartFailure {
    fn from_ns(error: &NSError) -> Self {
        let screen_capture_error =
            sck::framework().is_some_and(|framework| &*error.domain() == framework.error_domain);
        if screen_capture_error {
            match error.code() {
                -3801 | -3803 => return Self::Capture(CaptureError::PermissionDenied),
                -3818 => return Self::Audio,
                _ => {}
            }
        }
        Self::Capture(CaptureError::Failed)
    }

    fn capture_error(self) -> CaptureError {
        match self {
            Self::Audio => CaptureError::Failed,
            Self::Capture(error) => error,
        }
    }
}

enum PickerOutcome {
    Cancelled,
    Selected(FilterHandoff),
    Failed(CaptureError),
}

struct FilterHandoff(Retained<sck::Filter>);

// The picker hands us a retained filter. We transfer ownership to the main queue without reading
// or mutating the filter on the callback queue.
unsafe impl Send for FilterHandoff {}

impl FilterHandoff {
    fn into_inner(self) -> Retained<sck::Filter> {
        self.0
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "FalkyScreenSharingPickerObserver"]
    #[ivars = Arc<Request>]
    struct PickerObserver;

    unsafe impl NSObjectProtocol for PickerObserver {}

    unsafe impl PickerObserverProtocol for PickerObserver {
        #[unsafe(method(contentSharingPicker:didCancelForStream:))]
        fn cancelled(&self, _picker: &sck::Picker, stream: Option<&sck::Stream>) {
            if stream.is_none() {
                self.finish(PickerOutcome::Cancelled);
            }
        }

        #[unsafe(method(contentSharingPicker:didUpdateWithFilter:forStream:))]
        fn selected(&self, _picker: &sck::Picker, filter: &sck::Filter, stream: Option<&sck::Stream>) {
            if stream.is_none() {
                self.finish(PickerOutcome::Selected(FilterHandoff(filter.retain())));
            }
        }

        #[unsafe(method(contentSharingPickerStartDidFailWithError:))]
        fn failed(&self, error: &NSError) {
            self.finish(PickerOutcome::Failed(StartFailure::from_ns(error).capture_error()));
        }
    }
);

impl PickerObserver {
    fn new(request: Arc<Request>) -> Retained<Self> {
        let allocated = Self::alloc().set_ivars(request);
        unsafe { msg_send![super(allocated), init] }
    }

    fn finish(&self, result: PickerOutcome) {
        let request = Arc::clone(self.ivars());
        on_main(move |state| state.picker_outcome(&request, result));
    }
}

struct Attempt {
    request: Arc<Request>,
    live: AtomicBool,
    target_size: AtomicU64,
}

enum Phase {
    Starting {
        lost: Option<StartFailure>,
        stopped: bool,
    },
    Live,
    Ended,
}

struct NativeStream {
    attempt: Arc<Attempt>,
    filter: Retained<sck::Filter>,
    native: Retained<sck::Stream>,
    _output: Retained<StreamOutput>,
    phase: Phase,
    configured_size: Size,
    resize_failure: Option<ResizeFailure>,
    resizing: bool,
    with_audio: bool,
}

#[derive(Clone, Copy)]
struct ResizeFailure {
    size: Size,
    retried: bool,
}

impl NativeStream {
    fn new(
        request: Arc<Request>,
        filter: &sck::Filter,
        size: Size,
        options: CaptureOptions,
        sink: CaptureSink,
        with_audio: bool,
    ) -> Result<Self, StartFailure> {
        let (configuration, with_audio) = stream_configuration(size, options, with_audio);
        let attempt = Arc::new(Attempt {
            request,
            live: AtomicBool::new(false),
            target_size: AtomicU64::new(size.packed()),
        });
        let output = StreamOutput::new(Output {
            attempt: Arc::clone(&attempt),
            sink,
            options,
            audio_failed: AtomicBool::new(!with_audio),
        });
        let native = sck::Stream::with_filter(
            sck::Stream::alloc(),
            filter,
            &configuration,
            ProtocolObject::from_ref(&*output),
        );
        let protocol = ProtocolObject::from_ref(&*output);
        let video_queue = DispatchQueue::new("com.falky.screen-share.video", None);
        native
            .add_output(protocol, sck::SCREEN, &video_queue)
            .map_err(|error| StartFailure::from_ns(&error))?;
        if with_audio {
            let audio_queue = DispatchQueue::new("com.falky.screen-share.audio", None);
            native
                .add_output(protocol, sck::AUDIO, &audio_queue)
                .map_err(|_| StartFailure::Audio)?;
        }
        Ok(Self {
            attempt,
            filter: filter.retain(),
            native,
            _output: output,
            phase: Phase::Starting {
                lost: None,
                stopped: false,
            },
            configured_size: size,
            resize_failure: None,
            resizing: false,
            with_audio,
        })
    }

    fn owns(&self, attempt: &Arc<Attempt>) -> bool {
        Arc::ptr_eq(&self.attempt, attempt)
    }

    fn start(&self) {
        let attempt = Arc::clone(&self.attempt);
        let completion = RcBlock::new(move |error: *mut NSError| {
            let outcome =
                unsafe { error.as_ref() }.map_or(Ok(()), |error| Err(StartFailure::from_ns(error)));
            let attempt = Arc::clone(&attempt);
            on_main(move |state| state.start_finished(&attempt, outcome));
        });
        self.native.start_capture(&completion);
    }

    fn resize(&mut self, options: CaptureOptions) {
        if self.resizing || !matches!(self.phase, Phase::Live) {
            return;
        }
        let size = Size::unpack(self.attempt.target_size.load(Ordering::Relaxed));
        if let Some(failure) = self.resize_failure {
            if failure.size != size {
                self.resize_failure = None;
            } else if failure.retried {
                return;
            }
        }
        if self.configured_size == size {
            return;
        }
        let (configuration, with_audio) = stream_configuration(size, options, self.with_audio);
        if with_audio != self.with_audio {
            return;
        }

        let attempt = Arc::clone(&self.attempt);
        let completion = RcBlock::new(move |error: *mut NSError| {
            let succeeded = error.is_null();
            let attempt = Arc::clone(&attempt);
            on_main(move |state| state.resize_finished(&attempt, size, succeeded));
        });
        self.resizing = true;
        self.native
            .update_configuration(&configuration, Some(&completion));
    }

    fn stop(&self) {
        let attempt = Arc::clone(&self.attempt);
        let completion = RcBlock::new(move |_error: *mut NSError| {
            let attempt = Arc::clone(&attempt);
            on_main(move |state| state.retiring.retain(|stream| !stream.owns(&attempt)));
        });
        self.native.stop_capture(&completion);
    }
}

fn stream_configuration(
    size: Size,
    options: CaptureOptions,
    with_audio: bool,
) -> (Retained<sck::StreamConfiguration>, bool) {
    let configuration = sck::StreamConfiguration::new();
    configuration.set_width(size.width as usize);
    configuration.set_height(size.height as usize);
    configuration
        .set_minimum_frame_interval(unsafe { CMTime::new(1, options.fps.clamp(1, 60) as i32) });
    configuration.set_pixel_format(kCVPixelFormatType_32BGRA);
    configuration.preserve_aspect(true);
    configuration.ignore_window_shadows(true);
    let with_audio = with_audio && {
        configuration.exclude_own_audio(true);
        configuration.set_sample_rate(48_000);
        configuration.set_channel_count(2);
        configuration.excludes_own_audio()
    };
    if with_audio {
        configuration.capture_audio(true);
    }
    (configuration, with_audio)
}

struct Output {
    attempt: Arc<Attempt>,
    sink: CaptureSink,
    options: CaptureOptions,
    audio_failed: AtomicBool,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "FalkyScreenSharingOutput"]
    #[ivars = Output]
    struct StreamOutput;

    unsafe impl NSObjectProtocol for StreamOutput {}

    unsafe impl StreamDelegate for StreamOutput {
        #[unsafe(method(stream:didStopWithError:))]
        fn stopped(&self, _stream: &sck::Stream, error: &NSError) {
            self.ivars()
                .source_ended(StartFailure::from_ns(error), true);
        }
    }

    // The 15.2 callback can be registered independently of the older runtime protocol.
    impl StreamOutput {
        #[unsafe(method(streamDidBecomeInactive:))]
        fn inactive(&self, _stream: &sck::Stream) {
            self.ivars()
                .source_ended(StartFailure::Capture(CaptureError::Failed), false);
        }
    }

    unsafe impl StreamOutputProtocol for StreamOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn sample(&self, _stream: &sck::Stream, sample: &CMSampleBuffer, output_type: isize) {
            let output = self.ivars();
            if output.attempt.request.cancelled.load(Ordering::Acquire)
                || !unsafe { sample.is_valid() }
            {
                return;
            }
            match output_type {
                sck::SCREEN => output.video(sample),
                sck::AUDIO
                    if output.attempt.live.load(Ordering::Acquire)
                        && !output.audio_failed.load(Ordering::Relaxed)
                        && unsafe { sample.data_is_ready() }
                        && frames::audio(sample, &output.sink).is_none() =>
                {
                    output.audio_failed.store(true, Ordering::Relaxed);
                    output.sink.audio_unavailable();
                }
                _ => {}
            }
        }
    }
);

impl StreamOutput {
    fn new(output: Output) -> Retained<Self> {
        let allocated = Self::alloc().set_ivars(output);
        unsafe { msg_send![super(allocated), init] }
    }
}

impl Output {
    fn source_ended(&self, error: StartFailure, stopped: bool) {
        let attempt = Arc::clone(&self.attempt);
        on_main(move |state| state.source_ended(&attempt, error, stopped));
    }

    fn video(&self, sample: &CMSampleBuffer) {
        match frames::screen_sample(sample, self.options) {
            ScreenSample::Image { source_size }
                if self.attempt.live.load(Ordering::Acquire)
                    && unsafe { sample.data_is_ready() } =>
            {
                if let Some(size) = source_size
                    && self
                        .attempt
                        .target_size
                        .swap(size.packed(), Ordering::Relaxed)
                        != size.packed()
                {
                    let attempt = Arc::clone(&self.attempt);
                    on_main(move |state| state.resize(&attempt));
                }
                frames::video(sample, &self.sink);
            }
            ScreenSample::Stopped => {
                self.source_ended(StartFailure::Capture(CaptureError::Failed), true)
            }
            _ => {}
        }
    }
}
