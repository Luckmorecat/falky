use std::{
    slice,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use tokio::sync::oneshot;
use windows::{
    Foundation::{TimeSpan, TypedEventHandler},
    Graphics::{
        Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        SizeInt32,
    },
    Win32::{
        Foundation::{E_ABORT, E_UNEXPECTED, HMODULE},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::{
                D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
                D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext,
                ID3D11Multithread, ID3D11Texture2D,
            },
            Dxgi::{
                Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
                IDXGIDevice,
            },
        },
        System::WinRT::Direct3D11::{
            CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
        },
    },
    core::{Interface, Result},
};

use super::{
    Apartment, CaptureError, CaptureOptions, CaptureSink, GraphicsCaptureSession,
    RO_INIT_MULTITHREADED, Session, Stop, audio, report_error,
};

const FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
const BUFFERS: i32 = 2;
const DEVICE_CHECK_INTERVAL: Duration = Duration::from_secs(1);

pub(super) async fn start(
    item: GraphicsCaptureItem,
    options: CaptureOptions,
    audio: bool,
    sink: CaptureSink,
) -> std::result::Result<Session, CaptureError> {
    let (wake, signals) = mpsc::sync_channel(1);
    let (ready, started) = oneshot::channel();
    let stop = Arc::new(Stop {
        stopped: AtomicBool::new(false),
        wake,
    });
    let session = Session(stop.clone());
    thread::Builder::new()
        .name("screen-capture-video".into())
        .spawn(move || run(item, options, audio, sink, stop, signals, ready))
        .map_err(|error| {
            eprintln!("Falky could not start Windows screen capture: {error}");
            CaptureError::Failed
        })?;
    started.await.map_err(|_| CaptureError::Failed)??;
    Ok(session)
}

fn run(
    item: GraphicsCaptureItem,
    options: CaptureOptions,
    audio: bool,
    sink: CaptureSink,
    stop: Arc<Stop>,
    signals: mpsc::Receiver<()>,
    ready: oneshot::Sender<std::result::Result<(), CaptureError>>,
) {
    if stop.is_stopped() {
        return;
    }
    let _apartment = match Apartment::new(RO_INIT_MULTITHREADED) {
        Ok(apartment) => apartment,
        Err(error) => {
            let _ = ready.send(Err(report_error(error)));
            return;
        }
    };

    let interval = Duration::from_secs(1) / options.fps.max(1);
    let mut capture = match Video::start(item, interval, &stop) {
        Ok(capture) => capture,
        Err(error) => {
            if !stop.is_stopped() {
                let _ = ready.send(Err(report_error(error)));
            }
            return;
        }
    };
    if ready.send(Ok(())).is_err() || stop.is_stopped() {
        return;
    }
    if options.with_audio && (!audio || !audio::start(stop.clone(), sink.clone())) {
        sink.audio_unavailable();
    }

    let result = capture.frames(interval, options, &stop, signals, &sink);
    let stopped = stop.stopped.swap(true, Ordering::AcqRel);
    drop(capture);
    if !stopped {
        if let Err(error) = result {
            eprintln!("Falky Windows screen capture stopped: {error}");
        }
        sink.source_lost();
    }
}

struct Video {
    item: GraphicsCaptureItem,
    close_token: Option<i64>,
    frame_token: Option<i64>,
    closed: Arc<AtomicBool>,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt_device: IDirect3DDevice,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    size: SizeInt32,
    staging: Option<ID3D11Texture2D>,
    downscale: Option<Downscale>,
    packed: Vec<u8>,
}

impl Video {
    fn start(item: GraphicsCaptureItem, interval: Duration, stop: &Stop) -> Result<Self> {
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?
        };
        let device = device.ok_or(E_UNEXPECTED)?;
        let context = context.ok_or(E_UNEXPECTED)?;
        let multithread = context.cast::<ID3D11Multithread>()?;
        let _ = unsafe { multithread.SetMultithreadProtected(true) };
        let dxgi = device.cast::<IDXGIDevice>()?;
        let winrt_device = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
        let size = item.Size()?;
        let pool =
            Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, FORMAT, BUFFERS, size)?;
        let session = pool.CreateCaptureSession(&item)?;
        let mut capture = Self {
            item,
            close_token: None,
            frame_token: None,
            closed: Arc::new(AtomicBool::new(false)),
            device,
            context,
            winrt_device,
            pool,
            session,
            size,
            staging: None,
            downscale: None,
            packed: Vec::new(),
        };

        let closed = capture.closed.clone();
        let wake = stop.wake.clone();
        capture.close_token = Some(capture.item.Closed(&TypedEventHandler::new(move |_, _| {
            closed.store(true, Ordering::Release);
            let _ = wake.try_send(());
            Ok(())
        }))?);
        let wake = stop.wake.clone();
        capture.frame_token = Some(capture.pool.FrameArrived(&TypedEventHandler::new(
            move |_, _| {
                let _ = wake.try_send(());
                Ok(())
            },
        ))?);

        // Older capture sessions have no optional hardware pacing interface.
        let _ = capture.session.SetMinUpdateInterval(TimeSpan {
            Duration: interval.as_nanos().div_ceil(100) as i64,
        });
        if stop.is_stopped() {
            return Err(E_ABORT.into());
        }
        capture.session.StartCapture()?;
        Ok(capture)
    }

    fn frames(
        &mut self,
        interval: Duration,
        options: CaptureOptions,
        stop: &Stop,
        signals: mpsc::Receiver<()>,
        sink: &CaptureSink,
    ) -> Result<()> {
        let mut next_frame = Instant::now();
        let mut pending = false;
        while !stop.is_stopped() && !self.closed.load(Ordering::Acquire) {
            let now = Instant::now();
            if pending && now >= next_frame {
                pending = false;
                if let Some(frame) = self.latest()? {
                    next_frame = now + interval;
                    self.deliver(frame, options, sink)?;
                }
                continue;
            }

            let wait = if pending {
                next_frame.saturating_duration_since(now)
            } else {
                DEVICE_CHECK_INTERVAL
            };
            match signals.recv_timeout(wait) {
                Ok(()) => pending = true,
                Err(mpsc::RecvTimeoutError::Timeout) if !pending => {
                    unsafe { self.device.GetDeviceRemovedReason()? };
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        Ok(())
    }

    fn latest(&self) -> Result<Option<Frame>> {
        let mut frame = None;
        for _ in 0..BUFFERS {
            match self.pool.TryGetNextFrame() {
                Ok(newest) => frame = Some(Frame(newest)),
                // An empty pool returns a successful null frame.
                Err(error) if error.code().is_ok() => break,
                Err(error) => return Err(error),
            }
        }
        Ok(frame)
    }

    fn deliver(&mut self, frame: Frame, options: CaptureOptions, sink: &CaptureSink) -> Result<()> {
        let size = frame.0.ContentSize()?;
        if size.Width <= 0 || size.Height <= 0 {
            return Ok(());
        }
        if size != self.size {
            // Recreate discards queued frames. Release the checked-out frame first.
            drop(frame);
            self.pool
                .Recreate(&self.winrt_device, FORMAT, BUFFERS, size)?;
            self.size = size;
            self.staging = None;
            self.downscale = None;
            return Ok(());
        }

        let width = size.Width as u32;
        let height = size.Height as u32;
        if self.staging.is_none() {
            self.staging = Some(self.staging_texture(width, height)?);
            self.downscale = Downscale::new(width, height, options);
        }
        let staging = self.staging.as_ref().unwrap();
        let surface = frame.0.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?;
        let texture: ID3D11Texture2D = unsafe { surface.GetInterface()? };
        let mapped = MappedFrame::new(&self.context, staging, &texture, size)?;
        if let Some(downscale) = &mut self.downscale {
            downscale.deliver(&mapped, sink);
        } else {
            sink.bgra(
                width,
                height,
                mapped.row_bytes,
                mapped.pixels(&mut self.packed),
            );
        }
        Ok(())
    }

    fn staging_texture(&self, width: u32, height: u32) -> Result<ID3D11Texture2D> {
        let description = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            ..Default::default()
        };
        let mut texture = None;
        unsafe {
            self.device
                .CreateTexture2D(&description, None, Some(&mut texture))?
        };
        texture.ok_or_else(|| E_UNEXPECTED.into())
    }
}

impl Drop for Video {
    fn drop(&mut self) {
        if let Some(token) = self.close_token {
            let _ = self.item.RemoveClosed(token);
        }
        if let Some(token) = self.frame_token {
            let _ = self.pool.RemoveFrameArrived(token);
        }
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

struct Frame(Direct3D11CaptureFrame);

impl Drop for Frame {
    fn drop(&mut self) {
        let _ = self.0.Close();
    }
}

struct MappedFrame<'a> {
    context: &'a ID3D11DeviceContext,
    staging: &'a ID3D11Texture2D,
    data: D3D11_MAPPED_SUBRESOURCE,
    row_bytes: usize,
    height: usize,
}

impl<'a> MappedFrame<'a> {
    fn new(
        context: &'a ID3D11DeviceContext,
        staging: &'a ID3D11Texture2D,
        texture: &ID3D11Texture2D,
        size: SizeInt32,
    ) -> Result<Self> {
        let mut data = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            context.CopyResource(staging, texture);
            context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut data))?;
        }
        let frame = Self {
            context,
            staging,
            data,
            row_bytes: size.Width as usize * 4,
            height: size.Height as usize,
        };
        let stride = data.RowPitch as usize;
        if data.pData.is_null()
            || stride < frame.row_bytes
            || stride
                .checked_mul(frame.height)
                .is_none_or(|bytes| bytes > isize::MAX as usize)
        {
            return Err(E_UNEXPECTED.into());
        }
        Ok(frame)
    }

    fn row(&self, y: usize) -> &[u8] {
        assert!(y < self.height);
        let offset = y * self.data.RowPitch as usize;
        // The texture is mapped for the life of this guard. Driver row padding need not be initialized.
        unsafe { slice::from_raw_parts(self.data.pData.cast::<u8>().add(offset), self.row_bytes) }
    }

    fn pixels<'b>(&'b self, packed: &'b mut Vec<u8>) -> &'b [u8] {
        if self.data.RowPitch as usize == self.row_bytes {
            return unsafe {
                slice::from_raw_parts(self.data.pData.cast(), self.row_bytes * self.height)
            };
        }
        packed.clear();
        packed.reserve(self.row_bytes * self.height);
        for y in 0..self.height {
            packed.extend_from_slice(self.row(y));
        }
        packed
    }
}

impl Drop for MappedFrame<'_> {
    fn drop(&mut self) {
        unsafe { self.context.Unmap(self.staging, 0) };
    }
}

struct Downscale {
    columns: Vec<Sample>,
    rows: Vec<Sample>,
    pixels: Vec<u8>,
}

impl Downscale {
    fn new(width: u32, height: u32, options: CaptureOptions) -> Option<Self> {
        let (max_width, max_height) = if width < height {
            (options.max_height, options.max_width)
        } else {
            (options.max_width, options.max_height)
        };
        let scale = (f64::from(max_width) / f64::from(width))
            .min(f64::from(max_height) / f64::from(height));
        if scale >= 1.0 {
            return None;
        }

        let out_width = (f64::from(width) * scale).round().max(1.0) as usize;
        let out_height = (f64::from(height) * scale).round().max(1.0) as usize;
        Some(Self {
            columns: Sample::axis(width as usize, out_width),
            rows: Sample::axis(height as usize, out_height),
            pixels: vec![0; out_width * out_height * 4],
        })
    }

    fn deliver(&mut self, mapped: &MappedFrame<'_>, sink: &CaptureSink) {
        let out_stride = self.columns.len() * 4;
        for (output, &y) in self.pixels.chunks_exact_mut(out_stride).zip(&self.rows) {
            let top = mapped.row(y.first);
            let bottom = mapped.row(y.second);
            let (pixels, _) = output.as_chunks_mut::<4>();
            for (destination, &x) in pixels.iter_mut().zip(&self.columns) {
                for (channel, value) in destination.iter_mut().take(3).enumerate() {
                    let left = x.first * 4 + channel;
                    let right = x.second * 4 + channel;
                    let top_value = x.interpolate(u16::from(top[left]), u16::from(top[right]));
                    let bottom_value =
                        x.interpolate(u16::from(bottom[left]), u16::from(bottom[right]));
                    *value = y.interpolate(top_value, bottom_value) as u8;
                }
                destination[3] = u8::MAX;
            }
        }
        sink.bgra(
            self.columns.len() as u32,
            self.rows.len() as u32,
            out_stride,
            &self.pixels,
        );
    }
}

#[derive(Clone, Copy)]
struct Sample {
    first: usize,
    second: usize,
    weight: u16,
}

impl Sample {
    fn axis(source: usize, dest: usize) -> Vec<Self> {
        (0..dest)
            .map(|index| {
                let center = (index as f64 + 0.5) * source as f64 / dest as f64 - 0.5;
                let first = center as usize;
                let second = (first + 1).min(source - 1);
                let weight = (center.fract() * 256.0).round() as u16;
                Self {
                    first,
                    second,
                    weight,
                }
            })
            .collect()
    }

    fn interpolate(self, first: u16, second: u16) -> u16 {
        (first * (256 - self.weight) + second * self.weight + 128) / 256
    }
}
