use std::{mem, ptr, slice};

use objc2_core_audio_types::{
    AudioBuffer, AudioBufferList, kAudioFormatFlagIsBigEndian, kAudioFormatFlagIsFloat,
    kAudioFormatFlagIsNonInterleaved, kAudioFormatFlagIsSignedInteger, kAudioFormatLinearPCM,
};
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFType, CGRect, ConcreteType};
use objc2_core_graphics::CGRectMakeWithDictionaryRepresentation;
use objc2_core_media::{CMAudioFormatDescriptionGetStreamBasicDescription, CMSampleBuffer};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetDataSize, CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType,
    CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress, kCVPixelFormatType_32BGRA,
};
use objc2_foundation::NSString;

use super::{CaptureOptions, CaptureSink, sck};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Size {
    pub(super) width: u32,
    pub(super) height: u32,
}

impl Size {
    pub(super) fn fit(width: f64, height: f64, options: CaptureOptions) -> Option<Self> {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return None;
        }
        let (mut max_width, mut max_height) = (options.max_width, options.max_height);
        if (width < height) != (max_width < max_height) {
            mem::swap(&mut max_width, &mut max_height);
        }
        let scale = (f64::from(max_width.max(2)) / width)
            .min(f64::from(max_height.max(2)) / height)
            .min(1.0);
        let even = |dimension: f64| ((dimension * scale).round() as u32).max(2) & !1;
        Some(Self {
            width: even(width),
            height: even(height),
        })
    }

    pub(super) fn packed(self) -> u64 {
        (u64::from(self.width) << 32) | u64::from(self.height)
    }

    pub(super) fn unpack(value: u64) -> Self {
        Self {
            width: (value >> 32) as u32,
            height: value as u32,
        }
    }
}

const COMPLETE_FRAME: i64 = 0;
const STARTED_FRAME: i64 = 4;
const STOPPED_FRAME: i64 = 5;

pub(super) enum ScreenSample {
    Image { source_size: Option<Size> },
    Stopped,
    Skip,
}

pub(super) fn screen_sample(buffer: &CMSampleBuffer, options: CaptureOptions) -> ScreenSample {
    let Some(framework) = sck::framework() else {
        return ScreenSample::Skip;
    };
    let attachments = unsafe { buffer.sample_attachments_array(false) };
    let dictionary = attachments.as_deref().and_then(|attachments| {
        if attachments.count() == 0 {
            return None;
        }
        // ScreenCaptureKit's single frame attachment is a dictionary of documented values.
        unsafe {
            attachments
                .value_at_index(0)
                .cast::<CFDictionary>()
                .as_ref()
        }
    });
    let Some(dictionary) = dictionary else {
        return ScreenSample::Image { source_size: None };
    };
    match field::<CFNumber>(dictionary, framework.status_key).and_then(CFNumber::as_i64) {
        Some(STOPPED_FRAME) => return ScreenSample::Stopped,
        Some(COMPLETE_FRAME | STARTED_FRAME) | None => {}
        _ => return ScreenSample::Skip,
    }
    let source_size = (|| {
        let rect = field::<CFDictionary>(dictionary, framework.content_rect_key)?;
        let mut bounds = CGRect::default();
        if !unsafe { CGRectMakeWithDictionaryRepresentation(Some(rect), &mut bounds) } {
            return None;
        }
        let source_scale = field::<CFNumber>(dictionary, framework.scale_factor_key)?.as_f64()?;
        let content_scale = field::<CFNumber>(dictionary, framework.content_scale_key)?.as_f64()?;
        let scale = source_scale / content_scale;
        Size::fit(
            bounds.size.width * scale,
            bounds.size.height * scale,
            options,
        )
    })();
    ScreenSample::Image { source_size }
}

fn field<'a, T: ConcreteType>(dictionary: &'a CFDictionary, key: &NSString) -> Option<&'a T> {
    // ScreenCaptureKit's attachment dictionaries store Core Foundation objects.
    let value = unsafe {
        dictionary
            .value(ptr::from_ref(key).cast())
            .cast::<CFType>()
            .as_ref()
    }?;
    value.downcast_ref::<T>()
}

pub(super) fn video(buffer: &CMSampleBuffer, sink: &CaptureSink) {
    let Some(image) = (unsafe { buffer.image_buffer() }) else {
        return;
    };
    if CVPixelBufferGetPixelFormatType(&image) != kCVPixelFormatType_32BGRA {
        return;
    }
    let flags = CVPixelBufferLockFlags::ReadOnly;
    if unsafe { CVPixelBufferLockBaseAddress(&image, flags) } != 0 {
        return;
    }
    struct Unlock<'a>(&'a CVPixelBuffer);
    impl Drop for Unlock<'_> {
        fn drop(&mut self) {
            unsafe { CVPixelBufferUnlockBaseAddress(self.0, CVPixelBufferLockFlags::ReadOnly) };
        }
    }
    let _unlock = Unlock(&image);
    let width = CVPixelBufferGetWidth(&image);
    let height = CVPixelBufferGetHeight(&image);
    let stride = CVPixelBufferGetBytesPerRow(&image);
    let Some(row_bytes) = width.checked_mul(4) else {
        return;
    };
    let Some(minimum_length) = height
        .checked_sub(1)
        .and_then(|rows| stride.checked_mul(rows))
        .and_then(|bytes| bytes.checked_add(row_bytes))
    else {
        return;
    };
    let base = CVPixelBufferGetBaseAddress(&image).cast::<u8>();
    let length = CVPixelBufferGetDataSize(&image)
        .min(stride.saturating_mul(height))
        .min(isize::MAX as usize);
    if base.is_null()
        || width == 0
        || width > u32::MAX as usize
        || height > u32::MAX as usize
        || stride < row_bytes
        || length < minimum_length
    {
        return;
    }
    let pixels = unsafe { slice::from_raw_parts(base, length) };
    sink.bgra(width as u32, height as u32, stride, pixels);
}

#[repr(C)]
struct StereoBuffers {
    count: u32,
    buffers: [AudioBuffer; 2],
}

pub(super) fn audio(buffer: &CMSampleBuffer, sink: &CaptureSink) -> Option<()> {
    let frames = usize::try_from(unsafe { buffer.num_samples() }).ok()?;
    if frames == 0 {
        return Some(());
    }
    let description = unsafe { buffer.format_description()? };
    let format =
        unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&description).as_ref()? };
    if format.mFormatID != kAudioFormatLinearPCM
        || format.mChannelsPerFrame != 2
        || format.mSampleRate != 48_000.0
        || format.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
    {
        return None;
    }
    let noninterleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0;
    let (bytes, read): (usize, fn(&[u8]) -> i16) =
        if format.mBitsPerChannel == 32 && format.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
            (4, |bytes| {
                let value = f32::from_ne_bytes(bytes.try_into().expect("four bytes"));
                (value * 32768.0).round() as i16
            })
        } else if format.mBitsPerChannel == 16
            && format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0
        {
            (2, |bytes| {
                i16::from_ne_bytes(bytes.try_into().expect("two bytes"))
            })
        } else {
            return None;
        };
    let channels_per_buffer = if noninterleaved { 1 } else { 2 };
    if format.mBytesPerFrame as usize != channels_per_buffer * bytes {
        return None;
    }
    let empty = AudioBuffer {
        mNumberChannels: 0,
        mDataByteSize: 0,
        mData: ptr::null_mut(),
    };
    let mut list = StereoBuffers {
        count: 0,
        buffers: [empty; 2],
    };
    let mut owner = ptr::null_mut();
    let status = unsafe {
        buffer.audio_buffer_list_with_retained_block_buffer(
            ptr::null_mut(),
            ptr::from_mut(&mut list).cast::<AudioBufferList>(),
            mem::size_of_val(&list),
            None,
            None,
            0,
            &mut owner,
        )
    };
    let owner = std::ptr::NonNull::new(owner).map(|owner| unsafe { CFRetained::from_raw(owner) });
    if status != 0 || owner.is_none() || list.count as usize != 3 - channels_per_buffer {
        return None;
    }
    let length = frames.checked_mul(channels_per_buffer * bytes)?;
    let data = |index: usize| {
        let info = &list.buffers[index];
        if info.mData.is_null()
            || info.mNumberChannels as usize != channels_per_buffer
            || length > info.mDataByteSize as usize
            || length > isize::MAX as usize
        {
            return None;
        }
        Some(unsafe { slice::from_raw_parts(info.mData.cast::<u8>(), length) })
    };
    let first = data(0)?.chunks_exact(bytes);
    let mut pcm = Vec::with_capacity(frames.checked_mul(2)?);
    if noninterleaved {
        for (left, right) in first.zip(data(1)?.chunks_exact(bytes)) {
            pcm.extend([read(left), read(right)]);
        }
    } else {
        pcm.extend(first.map(read));
    }
    sink.stereo(&pcm);
    Some(())
}
