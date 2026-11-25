use std::{
    io::Cursor,
    os::{fd::OwnedFd, unix::net::UnixStream},
    thread,
    time::Instant,
};

use ::pipewire as pw;
use pw::spa::{
    buffer::{
        ChunkFlags, DataType,
        meta::{MetaVideoCrop, Metadata},
    },
    param::{
        ParamType,
        format::{FormatProperties, MediaSubtype, MediaType},
        format_utils::parse_format,
        video::{VideoFormat, VideoInfoRaw},
    },
    pod::{ChoiceValue, Object, Pod, Property, Value, serialize::PodSerializer},
    support::system::IoFlags,
    sys,
    utils::{Choice, ChoiceEnum, ChoiceFlags, Direction, Fraction, Id, Rectangle, SpaTypes},
};
use tokio::sync::oneshot;

use super::{
    CaptureError, CaptureOptions, CaptureSink,
    frame::{Frame, Pacing, Rect},
};

pub(super) struct Capture {
    ready: oneshot::Receiver<()>,
    stopped: oneshot::Receiver<()>,
    _stop: UnixStream,
}

impl Capture {
    pub fn start(
        remote: OwnedFd,
        node: u32,
        serial: Option<u64>,
        options: CaptureOptions,
        sink: CaptureSink,
    ) -> Result<Self, CaptureError> {
        if options.max_width == 0
            || options.max_height == 0
            || options.fps == 0
            || (serial.is_none() && matches!(node, 0 | pw::constants::ID_ANY))
        {
            return Err(CaptureError::Failed);
        }
        let (stop, stop_signal) = UnixStream::pair().map_err(|_| CaptureError::Failed)?;
        let (signal_ready, ready) = oneshot::channel();
        let (signal_stopped, stopped) = oneshot::channel();
        thread::Builder::new()
            .name("screen-share-pipewire".into())
            .spawn(move || {
                let _ = run(
                    remote,
                    node,
                    serial,
                    options,
                    sink,
                    stop_signal,
                    signal_ready,
                );
                let _ = signal_stopped.send(());
            })
            .map_err(|_| CaptureError::Failed)?;
        Ok(Self {
            ready,
            stopped,
            _stop: stop,
        })
    }

    pub async fn ready(&mut self) -> Result<(), CaptureError> {
        (&mut self.ready).await.map_err(|_| CaptureError::Failed)
    }

    pub async fn stopped(&mut self) {
        let _ = (&mut self.stopped).await;
    }
}

fn run(
    remote: OwnedFd,
    node: u32,
    serial: Option<u64>,
    options: CaptureOptions,
    sink: CaptureSink,
    stop_signal: UnixStream,
    signal_ready: oneshot::Sender<()>,
) -> Result<(), CaptureError> {
    pw::init();
    let loop_ = pw::main_loop::MainLoopRc::new(None).map_err(|_| CaptureError::Failed)?;
    let context = pw::context::ContextRc::new(&loop_, None).map_err(|_| CaptureError::Failed)?;
    let core = context
        .connect_fd_rc(remote, None)
        .map_err(|_| CaptureError::Failed)?;
    let _stop = loop_
        .loop_()
        .add_io(stop_signal, IoFlags::IN | IoFlags::HUP | IoFlags::ERR, {
            let loop_ = loop_.clone();
            move |_| loop_.quit()
        });
    let _core_listener = core
        .add_listener_local()
        .error({
            let loop_ = loop_.clone();
            move |id, _, code, _| {
                if id == pw::core::PW_ID_CORE && code < 0 {
                    loop_.quit();
                }
            }
        })
        .register();
    let registry = core.get_registry().map_err(|_| CaptureError::Failed)?;
    let _registry_listener = registry
        .add_listener_local()
        .global_remove({
            let loop_ = loop_.clone();
            move |id| {
                if id == node {
                    loop_.quit();
                }
            }
        })
        .register();

    let mut properties = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Video",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Screen",
    };
    let target = if let Some(serial) = serial {
        properties.insert("target.object", serial.to_string());
        None
    } else {
        Some(node)
    };
    let stream = pw::stream::StreamBox::new(&core, "Falky screen share", properties)
        .map_err(|_| CaptureError::Failed)?;

    let buffers = buffer_request()?;
    let crop = crop_request()?;
    let _listener = stream
        .add_local_listener_with_user_data(Frames {
            signal_ready: Some(signal_ready),
            format: None,
            pacing: Pacing::new(options.fps),
            scratch: Vec::new(),
        })
        .state_changed({
            let loop_ = loop_.clone();
            move |_, _, _, state| {
                if matches!(
                    state,
                    pw::stream::StreamState::Unconnected | pw::stream::StreamState::Error(_)
                ) {
                    loop_.quit();
                }
            }
        })
        .param_changed({
            let loop_ = loop_.clone();
            move |stream, frames, id, param| {
                if id != ParamType::Format.as_raw() {
                    return;
                }
                frames.format = param.and_then(read_format);
                if param.is_some()
                    && (frames.format.is_none() || update_buffers(stream, &buffers, &crop).is_err())
                {
                    loop_.quit();
                }
            }
        })
        .process({
            let loop_ = loop_.clone();
            move |stream, frames| {
                if frames.publish(stream, options, &sink).is_err() {
                    loop_.quit();
                }
            }
        })
        .register()
        .map_err(|_| CaptureError::Failed)?;

    let preferred = format_request(options, options.fps)?;
    let fixed_rate_fallback = format_request(options, options.fps.max(1000))?;
    stream
        .connect(
            Direction::Input,
            target,
            pw::stream::StreamFlags::AUTOCONNECT
                | pw::stream::StreamFlags::MAP_BUFFERS
                | pw::stream::StreamFlags::DONT_RECONNECT,
            &mut [
                Pod::from_bytes(&preferred).ok_or(CaptureError::Failed)?,
                Pod::from_bytes(&fixed_rate_fallback).ok_or(CaptureError::Failed)?,
            ],
        )
        .map_err(|_| CaptureError::Failed)?;
    loop_.run();
    Ok(())
}

struct Frames {
    signal_ready: Option<oneshot::Sender<()>>,
    format: Option<VideoInfoRaw>,
    pacing: Pacing,
    scratch: Vec<u8>,
}

impl Frames {
    fn publish(
        &mut self,
        stream: &pw::stream::Stream,
        options: CaptureOptions,
        sink: &CaptureSink,
    ) -> Result<(), ()> {
        let mut newest = stream.dequeue_buffer();
        while let Some(buffer) = stream.dequeue_buffer() {
            newest = Some(buffer);
        }

        let now = Instant::now();
        let Some(mut buffer) = newest.filter(|_| self.pacing.due(now)) else {
            return Ok(());
        };
        let Some(format) = self.format else {
            return Ok(());
        };

        let crop = buffer
            .find_meta::<MetaVideoCrop>()
            .map(MetaVideoCrop::meta_region)
            .filter(|region| region.is_valid())
            .map(|region| Rect {
                x: region.position().x as u32,
                y: region.position().y as u32,
                width: region.size().width,
                height: region.size().height,
            });

        let [plane] = buffer.datas_mut() else {
            return Ok(());
        };
        let chunk = plane.chunk();
        let (offset, size, stride) = (chunk.offset(), chunk.size(), chunk.stride());
        if size == 0 || chunk.flags().contains(ChunkFlags::CORRUPTED) {
            return Ok(());
        }
        if !matches!(plane.type_(), DataType::MemPtr | DataType::MemFd) {
            return Err(());
        }
        let bytes = plane.data().ok_or(())?;
        let dimensions = format.size();
        let Some(frame) = Frame::new(
            bytes,
            offset,
            size,
            stride,
            dimensions.width,
            dimensions.height,
            crop,
        ) else {
            return Ok(());
        };
        let (width, height, stride, bytes) = frame.pixels(options, &mut self.scratch);
        if matches!(format.format(), VideoFormat::BGRA | VideoFormat::BGRx) {
            sink.bgra(width, height, stride, bytes);
        } else {
            sink.rgba(width, height, stride, bytes);
        }
        self.pacing.sent(now);
        if let Some(ready) = self.signal_ready.take() {
            ready.send(())?;
        }
        Ok(())
    }
}

fn read_format(param: &Pod) -> Option<VideoInfoRaw> {
    let (media_type, media_subtype) = parse_format(param).ok()?;
    if media_type != MediaType::Video
        || media_subtype != MediaSubtype::Raw
        || param
            .as_object()
            .ok()?
            .find_prop(Id(FormatProperties::VideoModifier.as_raw()))
            .is_some()
    {
        return None;
    }
    let mut format = VideoInfoRaw::new();
    format.parse(param).ok()?;
    let size = format.size();
    (size.width > 0
        && size.height > 0
        && matches!(
            format.format(),
            VideoFormat::BGRA | VideoFormat::BGRx | VideoFormat::RGBA | VideoFormat::RGBx
        ))
    .then_some(format)
}

fn update_buffers(
    stream: &pw::stream::Stream,
    buffers: &[u8],
    crop: &[u8],
) -> Result<(), CaptureError> {
    stream
        .update_params(&mut [
            Pod::from_bytes(buffers).ok_or(CaptureError::Failed)?,
            Pod::from_bytes(crop).ok_or(CaptureError::Failed)?,
        ])
        .map_err(|_| CaptureError::Failed)
}

fn buffer_request() -> Result<Vec<u8>, CaptureError> {
    // MAP_BUFFERS does not import or synchronize DMA-BUF. Negotiate the
    // compositor's shared-memory alternative and accept only mapped CPU data.
    let types = (1 << DataType::MemFd.as_raw()) | (1 << DataType::MemPtr.as_raw());
    encode(pw::spa::pod::object!(
        SpaTypes::ObjectParamBuffers,
        ParamType::Buffers,
        Property::new(sys::SPA_PARAM_BUFFERS_blocks, Value::Int(1)),
        Property::new(
            sys::SPA_PARAM_BUFFERS_dataType,
            Value::Choice(ChoiceValue::Int(Choice(
                ChoiceFlags::empty(),
                ChoiceEnum::Flags {
                    default: types,
                    flags: vec![]
                },
            )))
        ),
    ))
}

fn crop_request() -> Result<Vec<u8>, CaptureError> {
    encode(pw::spa::pod::object!(
        SpaTypes::ObjectParamMeta,
        ParamType::Meta,
        Property::new(
            sys::SPA_PARAM_META_type,
            Value::Id(Id(MetaVideoCrop::META_TYPE))
        ),
        Property::new(
            sys::SPA_PARAM_META_size,
            Value::Int(std::mem::size_of::<MetaVideoCrop>() as i32)
        ),
    ))
}

fn format_request(options: CaptureOptions, max_fps: u32) -> Result<Vec<u8>, CaptureError> {
    use pw::spa::pod::{object, property};

    let preferred = Fraction {
        num: options.fps,
        denom: 1,
    };
    let min_fps = Fraction { num: 0, denom: 1 };
    let max_fps = Fraction {
        num: max_fps,
        denom: 1,
    };
    encode(object!(
        SpaTypes::ObjectParamFormat,
        ParamType::EnumFormat,
        property!(FormatProperties::MediaType, Id, MediaType::Video),
        property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::BGRx,
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA
        ),
        // Compositors can require their native size. Prefer the requested size
        // and preserve the aspect ratio in the mapped frame if scaling is needed.
        property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle {
                width: options.max_width,
                height: options.max_height
            },
            Rectangle {
                width: 1,
                height: 1
            },
            Rectangle {
                width: u32::MAX,
                height: u32::MAX
            }
        ),
        property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            preferred,
            min_fps,
            max_fps
        ),
        property!(
            FormatProperties::VideoMaxFramerate,
            Choice,
            Range,
            Fraction,
            preferred,
            min_fps,
            max_fps
        ),
    ))
}

fn encode(parameter: Object) -> Result<Vec<u8>, CaptureError> {
    PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Object(parameter))
        .map(|(cursor, _)| cursor.into_inner())
        .map_err(|_| CaptureError::Failed)
}
