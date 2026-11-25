#![allow(clippy::missing_safety_doc)]

use std::{ffi::CStr, ptr::NonNull, sync::OnceLock};

use block2::DynBlock;
use dispatch2::DispatchQueue;
use objc2::{
    MainThreadMarker, extern_class, extern_conformance, extern_methods, extern_protocol,
    rc::{Allocated, Retained},
    runtime::{AnyClass, NSObject, NSObjectProtocol, ProtocolObject},
    sel,
};
use objc2_core_foundation::CGRect;
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_foundation::{NSError, NSNumber, NSProcessInfo, NSString};

const FRAMEWORK: &CStr = c"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit";

pub(super) struct Framework {
    pub(super) error_domain: &'static NSString,
    pub(super) status_key: &'static NSString,
    pub(super) content_rect_key: &'static NSString,
    pub(super) content_scale_key: &'static NSString,
    pub(super) scale_factor_key: &'static NSString,
}

// The exported strings are immutable and the library stays mapped for the process lifetime.
unsafe impl Send for Framework {}
unsafe impl Sync for Framework {}

pub(super) fn framework() -> Option<&'static Framework> {
    static LOADED: OnceLock<Option<Framework>> = OnceLock::new();
    LOADED.get_or_init(load).as_ref()
}

fn load() -> Option<Framework> {
    if NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        < 14
    {
        return None;
    }

    // Keeping this framework out of the load commands lets older macOS releases start Falky.
    let handle = NonNull::new(unsafe {
        libc::dlopen(FRAMEWORK.as_ptr(), libc::RTLD_LOCAL | libc::RTLD_LAZY)
    })?;
    let picker = AnyClass::get(c"SCContentSharingPicker")?;
    if !picker.metaclass().responds_to(sel!(sharedPicker)) {
        return None;
    }

    // These symbols are immutable Objective-C string globals. The library stays loaded.
    unsafe {
        Some(Framework {
            error_domain: string_symbol(handle, c"SCStreamErrorDomain")?,
            status_key: string_symbol(handle, c"SCStreamFrameInfoStatus")?,
            content_rect_key: string_symbol(handle, c"SCStreamFrameInfoContentRect")?,
            content_scale_key: string_symbol(handle, c"SCStreamFrameInfoContentScale")?,
            scale_factor_key: string_symbol(handle, c"SCStreamFrameInfoScaleFactor")?,
        })
    }
}

unsafe fn string_symbol(
    handle: NonNull<std::ffi::c_void>,
    symbol: &CStr,
) -> Option<&'static NSString> {
    let pointer =
        unsafe { libc::dlsym(handle.as_ptr(), symbol.as_ptr()) }.cast::<*const NSString>();
    unsafe { pointer.as_ref()?.as_ref() }
}

pub(super) fn audio_available() -> bool {
    AnyClass::get(c"SCStreamConfiguration").is_some_and(|class| {
        [
            sel!(setCapturesAudio:),
            sel!(setExcludesCurrentProcessAudio:),
            sel!(excludesCurrentProcessAudio),
            sel!(setSampleRate:),
            sel!(setChannelCount:),
        ]
        .into_iter()
        .all(|selector| class.responds_to(selector))
    })
}

extern_class!(
    #[unsafe(super(NSObject))]
    #[name = "SCContentSharingPicker"]
    pub(super) struct Picker;
);

impl Picker {
    extern_methods!(
        #[unsafe(method(sharedPicker))]
        #[unsafe(method_family = none)]
        pub(super) fn shared(_main: MainThreadMarker) -> Retained<Self>;

        #[unsafe(method(setDefaultConfiguration:))]
        pub(super) fn configure(&self, configuration: &PickerConfiguration);

        #[unsafe(method(setMaximumStreamCount:))]
        pub(super) fn set_maximum_stream_count(&self, count: &NSNumber);

        #[unsafe(method(setActive:))]
        pub(super) fn set_active(&self, active: bool);

        #[unsafe(method(addObserver:))]
        pub(super) fn add_observer(&self, observer: &ProtocolObject<dyn PickerObserver>);

        #[unsafe(method(removeObserver:))]
        pub(super) fn remove_observer(&self, observer: &ProtocolObject<dyn PickerObserver>);

        #[unsafe(method(present))]
        pub(super) fn present(&self);
    );
}

extern_class!(
    #[unsafe(super(NSObject))]
    #[name = "SCContentSharingPickerConfiguration"]
    pub(super) struct PickerConfiguration;
);

impl PickerConfiguration {
    extern_methods!(
        #[unsafe(method(new))]
        pub(super) fn new() -> Retained<Self>;

        #[unsafe(method(setAllowedPickerModes:))]
        pub(super) fn set_allowed_modes(&self, modes: usize);

        #[unsafe(method(setAllowsChangingSelectedContent:))]
        pub(super) fn allow_source_changes(&self, allow: bool);
    );
}

pub(super) const SINGLE_WINDOW: usize = 1 << 0;
pub(super) const SINGLE_DISPLAY: usize = 1 << 4;

extern_class!(
    #[unsafe(super(NSObject))]
    #[name = "SCContentFilter"]
    pub(super) struct Filter;
);

impl Filter {
    extern_methods!(
        #[unsafe(method(contentRect))]
        pub(super) fn content_rect(&self) -> CGRect;

        #[unsafe(method(pointPixelScale))]
        pub(super) fn point_pixel_scale(&self) -> f32;
    );
}

extern_class!(
    #[unsafe(super(NSObject))]
    #[name = "SCStreamConfiguration"]
    pub(super) struct StreamConfiguration;
);

impl StreamConfiguration {
    extern_methods!(
        #[unsafe(method(new))]
        pub(super) fn new() -> Retained<Self>;

        #[unsafe(method(setWidth:))]
        pub(super) fn set_width(&self, width: usize);

        #[unsafe(method(setHeight:))]
        pub(super) fn set_height(&self, height: usize);

        #[unsafe(method(setMinimumFrameInterval:))]
        pub(super) fn set_minimum_frame_interval(&self, duration: CMTime);

        #[unsafe(method(setPixelFormat:))]
        pub(super) fn set_pixel_format(&self, format: u32);

        #[unsafe(method(setPreservesAspectRatio:))]
        pub(super) fn preserve_aspect(&self, preserve: bool);

        #[unsafe(method(setIgnoreShadowsSingleWindow:))]
        pub(super) fn ignore_window_shadows(&self, ignore: bool);

        #[unsafe(method(setCapturesAudio:))]
        pub(super) fn capture_audio(&self, enabled: bool);

        #[unsafe(method(setExcludesCurrentProcessAudio:))]
        pub(super) fn exclude_own_audio(&self, exclude: bool);

        #[unsafe(method(excludesCurrentProcessAudio))]
        pub(super) fn excludes_own_audio(&self) -> bool;

        #[unsafe(method(setSampleRate:))]
        pub(super) fn set_sample_rate(&self, rate: isize);

        #[unsafe(method(setChannelCount:))]
        pub(super) fn set_channel_count(&self, count: isize);
    );
}

extern_class!(
    #[unsafe(super(NSObject))]
    #[name = "SCStream"]
    pub(super) struct Stream;
);

extern_conformance!(
    unsafe impl NSObjectProtocol for Stream {}
);

impl Stream {
    extern_methods!(
        #[unsafe(method(initWithFilter:configuration:delegate:))]
        pub(super) fn with_filter(
            this: Allocated<Self>,
            filter: &Filter,
            configuration: &StreamConfiguration,
            delegate: &ProtocolObject<dyn StreamDelegate>,
        ) -> Retained<Self>;

        #[unsafe(method(addStreamOutput:type:sampleHandlerQueue:error:_))]
        pub(super) fn add_output(
            &self,
            output: &ProtocolObject<dyn StreamOutput>,
            output_type: isize,
            queue: &DispatchQueue,
        ) -> Result<(), Retained<NSError>>;

        #[unsafe(method(updateConfiguration:completionHandler:))]
        pub(super) fn update_configuration(
            &self,
            configuration: &StreamConfiguration,
            completion: Option<&DynBlock<dyn Fn(*mut NSError)>>,
        );

        #[unsafe(method(startCaptureWithCompletionHandler:))]
        pub(super) fn start_capture(&self, completion: &DynBlock<dyn Fn(*mut NSError)>);

        #[unsafe(method(stopCaptureWithCompletionHandler:))]
        pub(super) fn stop_capture(&self, completion: &DynBlock<dyn Fn(*mut NSError)>);
    );
}

pub(super) const SCREEN: isize = 0;
pub(super) const AUDIO: isize = 1;

extern_protocol!(
    /// # Safety
    ///
    /// Observer callbacks can arrive off the main thread.
    #[name = "SCContentSharingPickerObserver"]
    pub(super) unsafe trait PickerObserver: NSObjectProtocol {
        #[unsafe(method(contentSharingPicker:didCancelForStream:))]
        fn cancelled(&self, picker: &Picker, stream: Option<&Stream>);

        #[unsafe(method(contentSharingPicker:didUpdateWithFilter:forStream:))]
        fn selected(&self, picker: &Picker, filter: &Filter, stream: Option<&Stream>);

        #[unsafe(method(contentSharingPickerStartDidFailWithError:))]
        fn failed(&self, error: &NSError);
    }
);

extern_protocol!(
    /// # Safety
    ///
    /// Delegate callbacks can arrive on ScreenCaptureKit's internal queue.
    #[name = "SCStreamDelegate"]
    pub(super) unsafe trait StreamDelegate: NSObjectProtocol {
        #[optional]
        #[unsafe(method(stream:didStopWithError:))]
        fn stopped(&self, stream: &Stream, error: &NSError);
    }
);

extern_protocol!(
    /// # Safety
    ///
    /// Capture queues can invoke audio and video callbacks concurrently.
    #[name = "SCStreamOutput"]
    pub(super) unsafe trait StreamOutput: NSObjectProtocol {
        #[optional]
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn sample(&self, stream: &Stream, sample: &CMSampleBuffer, output_type: isize);
    }
);
