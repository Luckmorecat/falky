@group(0) @binding(0) var plane_y: texture_2d<f32>;
@group(0) @binding(1) var plane_u: texture_2d<f32>;
@group(0) @binding(2) var plane_v: texture_2d<f32>;
@group(0) @binding(3) var linear_filter: sampler;

override SRGB_TARGET: bool = false;

struct Vertex {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
    let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
    return Vertex(vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0), uv);
}

@fragment
fn fragment(input: Vertex) -> @location(0) vec4f {
    let y = (textureSample(plane_y, linear_filter, input.uv).r - 16.0 / 255.0) * (255.0 / 219.0);
    let uv = vec2f(
        textureSample(plane_u, linear_filter, input.uv).r,
        textureSample(plane_v, linear_filter, input.uv).r,
    );
    let chroma = (uv - vec2f(128.0 / 255.0)) * (255.0 / 224.0);
    let rgb = clamp(vec3f(
        y + 1.402 * chroma.y,
        y - dot(vec2f(0.344136, 0.714136), chroma),
        y + 1.772 * chroma.x,
    ), vec3f(0.0), vec3f(1.0));
    if SRGB_TARGET {
        let linear = select(pow((rgb + 0.055) / 1.055, vec3f(2.4)), rgb / 12.92, rgb <= vec3f(0.04045));
        return vec4f(linear, 1.0);
    }
    return vec4f(rgb, 1.0);
}
