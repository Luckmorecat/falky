use std::{cell::RefCell, fmt::Debug, sync::Arc};

use iced::advanced::{Layout, Widget, image, layout, renderer, widget::Tree, widget::tree};
use iced::widget::shader;
use iced::widget::shader::{Pipeline, Primitive, Program, Viewport};
use iced::{Element, Length, Rectangle, Renderer, Size, Theme, mouse};

#[derive(Clone, Copy, Debug)]
pub struct Plane<'a> {
    pub bytes: &'a [u8],
    pub stride: usize,
}

/// Top-down I420 with BT.601 limited-range samples and separately padded Y, U, and V rows.
pub trait PlanarFrame: Debug + Send + Sync {
    fn dimensions(&self) -> (u32, u32);
    fn planes(&self) -> [Plane<'_>; 3];
}

pub(super) fn contained(viewport: Size, (width, height): (u32, u32)) -> Size {
    let (width, height) = (width.max(1) as f32, height.max(1) as f32);
    let scale = (viewport.width / width).min(viewport.height / height);
    Size::new(width * scale, height * scale)
}

pub(super) fn widget<'a, Message: 'a>(
    frame: &Arc<dyn PlanarFrame>,
    size: Size,
) -> Element<'a, Message> {
    Element::new(ScreenVideo {
        frame: Arc::clone(frame),
        gpu: shader(Video(Arc::clone(frame)))
            .width(size.width)
            .height(size.height)
            .into(),
    })
}

struct ScreenVideo<'a, Message> {
    frame: Arc<dyn PlanarFrame>,
    gpu: Element<'a, Message>,
}

impl<Message> Widget<Message, Theme, Renderer> for ScreenVideo<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<RefCell<SoftwareFrame>>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(RefCell::new(SoftwareFrame::default()))
    }

    fn children(&self) -> Vec<Tree> {
        vec![Tree::new(self.gpu.as_widget())]
    }

    fn diff(&self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_ref(&self.gpu));
    }

    fn size(&self) -> Size<Length> {
        self.gpu.as_widget().size()
    }

    fn layout(
        &mut self,
        tree: &mut Tree,
        renderer: &Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        self.gpu
            .as_widget_mut()
            .layout(&mut tree.children[0], renderer, limits)
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        match renderer {
            Renderer::Primary(_) => self.gpu.as_widget().draw(
                &tree.children[0],
                renderer,
                theme,
                style,
                layout,
                cursor,
                viewport,
            ),
            Renderer::Secondary(software) => {
                let bounds = layout.bounds();
                if let Some(clip) = bounds.intersection(viewport)
                    && let Some(handle) = tree
                        .state
                        .downcast_ref::<RefCell<SoftwareFrame>>()
                        .borrow_mut()
                        .handle(&self.frame)
                {
                    let image =
                        image::Image::new(handle).filter_method(image::FilterMethod::Linear);
                    image::Renderer::draw_image(software, image, bounds, clip);
                }
            }
        }
    }
}

#[derive(Default)]
struct SoftwareFrame {
    source: Option<Arc<dyn PlanarFrame>>,
    rgba: Option<image::Handle>,
}

impl SoftwareFrame {
    fn handle(&mut self, frame: &Arc<dyn PlanarFrame>) -> Option<image::Handle> {
        if self
            .source
            .as_ref()
            .is_none_or(|previous| !Arc::ptr_eq(previous, frame))
        {
            self.rgba = rgba(frame.as_ref());
            self.source = Some(Arc::clone(frame));
        }
        self.rgba.clone()
    }
}

fn rgba(frame: &dyn PlanarFrame) -> Option<image::Handle> {
    let (width, height) = frame.dimensions();
    if width == 0 || height == 0 {
        return None;
    }
    let [y, u, v] = validated_planes(frame, (width, height))?;
    let row_bytes = (width as usize).checked_mul(4)?;
    let mut pixels = vec![0; row_bytes.checked_mul(height as usize)?];
    let encode = |value: i32| ((value + 128) >> 8).clamp(0, 255) as u8;
    for (row, output) in pixels.chunks_exact_mut(row_bytes).enumerate() {
        let y_row = &y.bytes[row * y.stride..];
        let u_row = &u.bytes[(row / 2) * u.stride..];
        let v_row = &v.bytes[(row / 2) * v.stride..];
        for (column, pixel) in output.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let luma = (i32::from(y_row[column]) - 16) * 298;
            let blue = i32::from(u_row[column / 2]) - 128;
            let red = i32::from(v_row[column / 2]) - 128;
            *pixel = [
                encode(luma + 409 * red),
                encode(luma - 100 * blue - 208 * red),
                encode(luma + 516 * blue),
                255,
            ];
        }
    }
    Some(image::Handle::from_rgba(width, height, pixels))
}

#[derive(Clone, Debug)]
pub(super) struct Video(pub Arc<dyn PlanarFrame>);

impl<Message> Program<Message> for Video {
    type State = ();
    type Primitive = Self;

    fn draw(&self, _: &(), _: mouse::Cursor, _: Rectangle) -> Self {
        self.clone()
    }
}

struct Textures {
    size: (u32, u32),
    planes: [wgpu::Texture; 3],
    bind: wgpu::BindGroup,
    uploaded: Option<Arc<dyn PlanarFrame>>,
}

pub(super) struct VideoPipeline {
    draw: wgpu::RenderPipeline,
    plane_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    textures: Option<Textures>,
    used: bool,
}

impl Primitive for Video {
    type Pipeline = VideoPipeline;

    fn prepare(
        &self,
        pipeline: &mut Self::Pipeline,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        _: &Rectangle,
        _: &Viewport,
    ) {
        let size = self.0.dimensions();
        let limit = device.limits().max_texture_dimension_2d;
        if size.0 == 0 || size.1 == 0 || size.0 > limit || size.1 > limit {
            return;
        }
        pipeline.used = true;
        if pipeline
            .textures
            .as_ref()
            .is_none_or(|current| current.size != size)
        {
            pipeline.textures = Some(Textures::new(device, pipeline, size));
        }
        let textures = pipeline.textures.as_mut().expect("share textures");
        if textures
            .uploaded
            .as_ref()
            .is_some_and(|previous| Arc::ptr_eq(previous, &self.0))
        {
            return;
        }

        let Some(planes) = validated_planes(self.0.as_ref(), size) else {
            return;
        };
        for ((plane, texture), (width, height)) in planes
            .into_iter()
            .zip(&textures.planes)
            .zip(plane_sizes(size))
        {
            queue.write_texture(
                texture.as_image_copy(),
                plane.bytes,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(plane.stride as u32),
                    rows_per_image: None,
                },
                extent(width, height),
            );
        }
        textures.uploaded = Some(Arc::clone(&self.0));
    }

    fn draw(&self, pipeline: &Self::Pipeline, pass: &mut wgpu::RenderPass<'_>) -> bool {
        if let Some(textures) = &pipeline.textures
            && textures
                .uploaded
                .as_ref()
                .is_some_and(|uploaded| Arc::ptr_eq(uploaded, &self.0))
        {
            pass.set_pipeline(&pipeline.draw);
            pass.set_bind_group(0, &textures.bind, &[]);
            pass.draw(0..3, 0..1);
        }
        true
    }
}

impl Textures {
    fn new(device: &wgpu::Device, pipeline: &VideoPipeline, size: (u32, u32)) -> Self {
        let planes = plane_sizes(size).map(|(width, height)| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Falky I420 plane"),
                size: extent(width, height),
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        });
        let [y, u, v] = planes
            .each_ref()
            .map(|plane| plane.create_view(&Default::default()));
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Falky I420 planes and sampler"),
            layout: &pipeline.plane_layout,
            entries: &[
                texture_binding(0, &y),
                texture_binding(1, &u),
                texture_binding(2, &v),
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&pipeline.sampler),
                },
            ],
        });
        Self {
            size,
            planes,
            bind,
            uploaded: None,
        }
    }
}

impl Pipeline for VideoPipeline {
    fn new(device: &wgpu::Device, _: &wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Falky screen share"),
            source: wgpu::ShaderSource::Wgsl(include_str!("share_video.wgsl").into()),
        });
        let plane_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Falky screen share layout"),
            entries: &[
                texture_layout(0),
                texture_layout(1),
                texture_layout(2),
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Falky screen share pipeline layout"),
            bind_group_layouts: &[&plane_layout],
            push_constant_ranges: &[],
        });
        let constants = [("SRGB_TARGET", f64::from(format.is_srgb()))];
        let draw = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Falky screen share pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &constants,
                    ..Default::default()
                },
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Falky screen share sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Self {
            draw,
            plane_layout,
            sampler,
            textures: None,
            used: false,
        }
    }

    fn trim(&mut self) {
        if !std::mem::take(&mut self.used) {
            self.textures = None;
        }
    }
}

fn texture_layout(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn texture_binding(binding: u32, view: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::TextureView(view),
    }
}

fn extent(width: u32, height: u32) -> wgpu::Extent3d {
    wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    }
}

fn plane_sizes((width, height): (u32, u32)) -> [(u32, u32); 3] {
    [
        (width, height),
        (width.div_ceil(2), height.div_ceil(2)),
        (width.div_ceil(2), height.div_ceil(2)),
    ]
}

fn validated_planes(frame: &dyn PlanarFrame, size: (u32, u32)) -> Option<[Plane<'_>; 3]> {
    let planes = frame.planes();
    planes
        .iter()
        .zip(plane_sizes(size))
        .all(|(plane, size)| valid_plane(*plane, size))
        .then_some(planes)
}

fn valid_plane(plane: Plane<'_>, (width, height): (u32, u32)) -> bool {
    let width = width as usize;
    plane.stride >= width
        && u32::try_from(plane.stride).is_ok()
        && plane
            .stride
            .checked_mul(height.saturating_sub(1) as usize)
            .and_then(|full_rows| full_rows.checked_add(width))
            .is_some_and(|length| length <= plane.bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_landscape_ultrawide_and_portrait_on_hidpi() {
        for (source, expected) in [
            ((1920, 1080), Size::new(960.0, 540.0)),
            ((2560, 1080), Size::new(960.0, 405.0)),
            ((1080, 1920), Size::new(337.5, 600.0)),
        ] {
            let viewport = Size::new(960.0, 600.0);
            let fitted = contained(viewport, source);
            assert_eq!(fitted, expected);
            assert_eq!(contained(viewport * 2.0, source), expected * 2.0);
        }
    }

    #[test]
    fn uneven_sizes_and_stride_do_not_assume_packed_rows() {
        assert_eq!(plane_sizes((5, 3)), [(5, 3), (3, 2), (3, 2)]);
        assert!(valid_plane(
            Plane {
                bytes: &[0; 21],
                stride: 8
            },
            (5, 3)
        ));
        assert!(!valid_plane(
            Plane {
                bytes: &[0; 20],
                stride: 8
            },
            (5, 3)
        ));
        assert!(!valid_plane(
            Plane {
                bytes: &[0; 24],
                stride: 4
            },
            (5, 3)
        ));
    }

    #[tokio::test]
    async fn software_frames_follow_the_visible_rows_and_cache_the_current_image() {
        use iced::advanced::renderer::{Headless, Renderer as _};
        use iced::{Color, Font, Pixels};

        #[derive(Debug)]
        struct PaddedPicture;

        impl PlanarFrame for PaddedPicture {
            fn dimensions(&self) -> (u32, u32) {
                (3, 3)
            }

            fn planes(&self) -> [Plane<'_>; 3] {
                [
                    Plane {
                        bytes: &[16, 235, 81, 255, 235, 16, 81, 255, 81, 81, 235],
                        stride: 4,
                    },
                    Plane {
                        bytes: &[128, 90, 255, 90, 128],
                        stride: 3,
                    },
                    Plane {
                        bytes: &[128, 240, 255, 255, 240, 128],
                        stride: 4,
                    },
                ]
            }
        }

        let frame: Arc<dyn PlanarFrame> = Arc::new(PaddedPicture);
        let mut cache = SoftwareFrame::default();
        let handle = cache.handle(&frame).unwrap();
        assert_eq!(cache.handle(&frame).unwrap().id(), handle.id());
        let image::Handle::Rgba {
            width,
            height,
            ref pixels,
            ..
        } = handle
        else {
            panic!("expected decoded RGBA");
        };
        assert_eq!((width, height), (3, 3));
        let black = [0, 0, 0, 255];
        let white = [255; 4];
        let red = [255, 0, 0, 255];
        let expected = [black, white, red, white, black, red, red, red, white].concat();
        assert_eq!(pixels.as_ref(), expected);
        let other: Arc<dyn PlanarFrame> = Arc::new(PaddedPicture);
        assert_ne!(cache.handle(&other).unwrap().id(), handle.id());

        let mut renderer = Renderer::new(Font::DEFAULT, Pixels(16.0), Some("tiny-skia"))
            .await
            .unwrap();
        assert!(matches!(renderer, Renderer::Secondary(_)));
        let size = Size::new(3.0, 3.0);
        let bounds = Rectangle::with_size(size);
        let mut widget: Element<'_, ()> = widget(&frame, size);
        let mut tree = Tree::new(widget.as_widget());
        let node = widget.as_widget_mut().layout(
            &mut tree,
            &renderer,
            &layout::Limits::new(Size::ZERO, size),
        );
        renderer.reset(bounds);
        widget.as_widget().draw(
            &tree,
            &mut renderer,
            &Theme::Dark,
            &renderer::Style::default(),
            Layout::new(&node),
            mouse::Cursor::Unavailable,
            &bounds,
        );
        let screenshot = renderer.screenshot(Size::new(3, 3), 1.0, Color::BLACK);
        assert_eq!(screenshot, expected);
    }
}
