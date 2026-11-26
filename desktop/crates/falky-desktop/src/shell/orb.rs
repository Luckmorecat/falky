use super::style;
use bytemuck::{Pod, Zeroable};
use iced::widget::shader::{Pipeline, Primitive, Program, Viewport};
use iced::{Color, Rectangle, mouse};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Mutex;

pub(super) const IDLE_SECONDS: f32 = 1.0 / 15.0;
pub(super) const TALK_PADDING: f32 = 1.12;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum Slot {
    Stage(usize),
    Room(usize),
    Ticker(usize),
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Orb {
    pub slot: Slot,
    pub seed: u32,
    pub colors: [Color; 4],
    pub now: f32,
    pub target_level: f32,
    pub grayscale: bool,
    pub still: bool,
    pub reduced_motion: bool,
    pub opacity: f32,
}

impl Orb {
    pub fn still(slot: Slot, seed: &str, colors: [Color; 4], opacity: f32) -> Self {
        Self {
            slot,
            seed: style::hash_string(seed),
            colors,
            opacity,
            now: 0.0,
            target_level: 0.0,
            grayscale: false,
            still: true,
            reduced_motion: false,
        }
    }
}

#[derive(Default)]
pub(super) struct Motion {
    seed: Option<u32>,
    frame: f32,
    paint: f32,
    angle: f32,
    flow: f32,
    level: f32,
    painted: [f32; 3],
}

impl Motion {
    fn sample(&mut self, orb: Orb) -> [f32; 3] {
        let first = self.seed != Some(orb.seed);
        if first {
            *self = Self {
                seed: Some(orb.seed),
                frame: orb.now,
                paint: orb.now,
                angle: (orb.seed % 628) as f32 / 100.0,
                flow: ((orb.seed >> 10) % 100) as f32 / 10.0,
                ..Self::default()
            };
        }
        let dt = (orb.now - self.frame).clamp(0.0, 0.15);
        self.frame = orb.now;
        let level = orb.target_level.clamp(0.0, 1.0);
        if orb.reduced_motion {
            self.level = level;
        } else {
            let rate = if level > self.level { 26.0 } else { 4.5 };
            self.level += (level - self.level) * (1.0 - (-dt * rate).exp());
            self.angle += dt * (0.07 + self.level * 0.9);
            self.flow += dt * (0.09 + self.level * 1.5);
        }
        if first
            || (!orb.still
                && (orb.reduced_motion
                    || self.level > 0.03
                    || orb.now - self.paint + 0.001 >= IDLE_SECONDS))
        {
            self.paint = orb.now;
            self.painted = [self.angle, self.flow, self.level];
        }
        self.painted
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
struct Uniform {
    stops: [[f32; 4]; 4],
    motion: [f32; 4],
    display: [f32; 4],
    shape: [f32; 4],
}

impl<Message> Program<Message> for Orb {
    type State = RefCell<Motion>;
    type Primitive = OrbDraw;

    fn draw(&self, state: &Self::State, _: mouse::Cursor, _: Rectangle) -> Self::Primitive {
        let mut state = state.borrow_mut();
        let [angle, flow, level] = state.sample(*self);
        let wobble = if self.reduced_motion {
            0.0
        } else {
            (state.paint * 5.1 + f32::from((self.seed % 997) as u16)).sin() * 0.02 * level
        };
        let padding = if self.still { 1.0 } else { TALK_PADDING };
        let scale = 1.0 + level * 0.09;
        OrbDraw {
            slot: self.slot,
            uniform: Uniform {
                stops: self.colors.map(|c| [c.r, c.g, c.b, 0.0]),
                motion: [(self.seed % 997) as f32 / 13.0, angle, flow, level],
                display: [0.0, f32::from(self.grayscale), 0.0, self.opacity],
                shape: [
                    (scale + wobble) / padding,
                    (scale - wobble) / padding,
                    0.0,
                    0.0,
                ],
            },
        }
    }
}

#[derive(Debug)]
pub(super) struct OrbDraw {
    slot: Slot,
    uniform: Uniform,
}

struct Tile {
    size: u32,
    used: bool,
    uniform: Option<Uniform>,
    buffer: wgpu::Buffer,
    paint: wgpu::BindGroup,
    composite: wgpu::BindGroup,
    picture: wgpu::TextureView,
}

pub(super) struct OrbPipeline {
    paint: wgpu::RenderPipeline,
    composite: wgpu::RenderPipeline,
    paint_layout: wgpu::BindGroupLayout,
    composite_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    tiles: HashMap<Slot, Tile>,
    picture_format: wgpu::TextureFormat,
    queue: wgpu::Queue,
    painting: Mutex<Option<wgpu::CommandEncoder>>,
}

impl Primitive for OrbDraw {
    type Pipeline = OrbPipeline;

    fn prepare(
        &self,
        pipeline: &mut Self::Pipeline,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bounds: &Rectangle,
        viewport: &Viewport,
    ) {
        let size = (bounds.width * viewport.scale_factor())
            .round()
            .clamp(1.0, 512.0) as u32;
        let tile = pipeline.tiles.entry(self.slot).or_insert_with(|| {
            Tile::new(
                device,
                pipeline.picture_format,
                size,
                &pipeline.paint_layout,
                &pipeline.composite_layout,
                &pipeline.sampler,
            )
        });
        if tile.size != size {
            *tile = Tile::new(
                device,
                pipeline.picture_format,
                size,
                &pipeline.paint_layout,
                &pipeline.composite_layout,
                &pipeline.sampler,
            );
        }
        tile.used = true;

        let mut uniform = self.uniform;
        uniform.display[0] = 2.0 / (size as f32 * uniform.shape[0]).max(1.0);
        uniform.display[2] = f32::from(pipeline.picture_format.is_srgb());
        if tile.uniform == Some(uniform) {
            return;
        }
        tile.uniform = Some(uniform);
        queue.write_buffer(&tile.buffer, 0, bytemuck::bytes_of(&uniform));
        let encoder = pipeline
            .painting
            .get_mut()
            .expect("orb paint mutex")
            .get_or_insert_with(|| {
                device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Falky orb texture cache"),
                })
            });
        #[cfg(test)]
        crate::perf_fixture::gpu_event(|work| work.passes += 1);
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Falky paint orb"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &tile.picture,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline.paint);
        pass.set_bind_group(0, &tile.paint, &[]);
        pass.draw(0..3, 0..1);
    }

    fn draw(&self, pipeline: &Self::Pipeline, pass: &mut wgpu::RenderPass<'_>) -> bool {
        // Iced prepares all primitives before drawing any of them. Submit the texture updates
        // as one batch before the enclosing compositor pass is submitted.
        if let Some(encoder) = pipeline.painting.lock().expect("orb paint mutex").take() {
            #[cfg(test)]
            crate::perf_fixture::gpu_event(|work| work.submissions += 1);
            pipeline.queue.submit([encoder.finish()]);
        }
        let tile = &pipeline.tiles[&self.slot];
        pass.set_pipeline(&pipeline.composite);
        pass.set_bind_group(0, &tile.composite, &[]);
        pass.draw(0..3, 0..1);
        true
    }
}

impl Tile {
    fn new(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        size: u32,
        paint_layout: &wgpu::BindGroupLayout,
        composite_layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
    ) -> Self {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Falky orb uniform"),
            size: std::mem::size_of::<Uniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Falky orb picture"),
            size: wgpu::Extent3d {
                width: size,
                height: size,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let picture = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let paint = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Falky orb uniform group"),
            layout: paint_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
        });
        let composite = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Falky orb picture group"),
            layout: composite_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&picture),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        });
        Self {
            size,
            used: false,
            uniform: None,
            buffer,
            paint,
            composite,
            picture,
        }
    }
}

impl Pipeline for OrbPipeline {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Falky flat FBM"),
            source: wgpu::ShaderSource::Wgsl(include_str!("orb.wgsl").into()),
        });
        let paint_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Falky orb uniform layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<Uniform>() as u64),
                },
                count: None,
            }],
        });
        let composite_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Falky orb picture layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let picture_format = if format.is_srgb() {
            wgpu::TextureFormat::Rgba8UnormSrgb
        } else {
            wgpu::TextureFormat::Rgba8Unorm
        };
        let paint = render_pipeline(
            device,
            &shader,
            &paint_layout,
            "fragment",
            picture_format,
            None,
        );
        let composite = render_pipeline(
            device,
            &shader,
            &composite_layout,
            "composite",
            format,
            Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Self {
            paint,
            composite,
            paint_layout,
            composite_layout,
            sampler,
            tiles: HashMap::new(),
            picture_format,
            queue: queue.clone(),
            painting: Mutex::new(None),
        }
    }

    fn trim(&mut self) {
        self.tiles.retain(|_, tile| std::mem::take(&mut tile.used));
    }
}

fn render_pipeline(
    device: &wgpu::Device,
    shader: &wgpu::ShaderModule,
    bind_group: &wgpu::BindGroupLayout,
    fragment: &str,
    format: wgpu::TextureFormat,
    blend: Option<wgpu::BlendState>,
) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Falky orb pipeline layout"),
        bind_group_layouts: &[bind_group],
        push_constant_ranges: &[],
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Falky orb pipeline"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vertex"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(fragment),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: Default::default(),
        multisample: Default::default(),
        depth_stencil: None,
        multiview: None,
        cache: None,
    })
}
