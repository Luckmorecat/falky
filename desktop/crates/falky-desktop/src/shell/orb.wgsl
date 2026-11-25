struct Orb {
    base: vec4<f32>,
    bright: vec4<f32>,
    deep: vec4<f32>,
    core: vec4<f32>,
    motion: vec4<f32>,
    display: vec4<f32>,
    shape: vec4<f32>,
}

@group(0) @binding(0) var<uniform> orb: Orb;

struct VertexResult {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> VertexResult {
    // WebGL's texture coordinates use positive y at the top of this shape.
    let positions = array(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    var out: VertexResult;
    out.position = vec4(positions[index], 0.0, 1.0);
    out.uv = positions[index];
    return out;
}

fn hash(point: vec3<f32>) -> f32 {
    let p = fract(point * 0.3183099 + 0.1) * 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

fn noise(x: vec3<f32>) -> f32 {
    let i = floor(x);
    let fraction = fract(x);
    let f = fraction * fraction * (3.0 - 2.0 * fraction);
    return mix(
        mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
            mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
            mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
        f.z,
    );
}

fn fbm(p: vec3<f32>) -> f32 {
    return noise(p) * 0.84 + noise(p * 2.03 + 3.1) * 0.16;
}

fn shape(p: vec2<f32>) -> f32 {
    let a = pow(abs(p), vec2(3.4));
    return pow(a.x + a.y, 1.0 / 3.4);
}

fn grain_hash(point: vec3<f32>) -> f32 {
    var p = fract(point * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

fn poured_color(n: vec3<f32>) -> vec3<f32> {
    let seed = orb.motion.x;
    let angle = orb.motion.y;
    let flow = orb.motion.z;
    let level = orb.motion.w;
    let c = cos(angle);
    let s = sin(angle);
    let spun = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
    let p = vec3(spun.x, 0.94 * spun.y - 0.34 * spun.z, 0.34 * spun.y + 0.94 * spun.z) * 0.95 + seed;
    let q = vec2(fbm(p + vec3(0.0, 0.0, flow)), fbm(p + vec3(5.2, 1.3, -flow * 0.8)));
    let warp = 1.7 + level * 1.1;
    let cloud = fbm(p + vec3(q, q.x) * warp);
    let under = fbm(p * 1.1 + vec3(q.yx, q.y) * warp + 7.7);
    var color = mix(orb.base.rgb, orb.deep.rgb, smoothstep(0.5, 0.74, under) * 0.85);
    color = mix(color, orb.bright.rgb, smoothstep(0.4, 0.64, cloud));
    return mix(color, orb.core.rgb, smoothstep(0.54, 0.74, cloud) * (0.82 + level * 0.18));
}

fn linear(color: vec3<f32>) -> vec3<f32> {
    let value = clamp(color, vec3(0.0), vec3(1.0));
    return select(value / 12.92, pow((value + 0.055) / 1.055, vec3(2.4)), value > vec3(0.04045));
}

@fragment
fn fragment(in: VertexResult) -> @location(0) vec4<f32> {
    let uv = in.uv / orb.shape.xy;
    let d = shape(uv);
    let alpha = 1.0 - smoothstep(1.0 - orb.display.x * 1.6, 1.0, d);
    if alpha <= 0.0 {
        return vec4(0.0);
    }

    let n = vec3(uv / max(length(uv), 1e-4) * min(d, 1.0), sqrt(max(0.0, 1.0 - d * d)));
    var color = poured_color(n);
    let light = normalize(vec3(-0.5, 0.62, 0.72));
    let diffuse = max(dot(n, light), 0.0);
    let shadow = mix(orb.deep.rgb, orb.base.rgb, 0.55) * 0.86;
    color = mix(color, shadow, (1.0 - smoothstep(0.0, 0.72, diffuse)) * 0.62);
    color += pow(max(dot(n, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 14.0) * 0.07;
    color *= 1.0 + orb.motion.w * 0.14;
    let edge = pow(1.0 - n.z, 3.2);
    color = mix(color, mix(orb.bright.rgb, vec3(1.0), 0.35), edge * (0.5 + orb.motion.w * 0.5));
    color += (grain_hash(vec3(in.position.xy, orb.motion.x)) - 0.5) * 0.045;
    let gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(color, vec3(gray), orb.display.y);
    if orb.display.z > 0.5 {
        color = linear(color);
    }
    let opacity = alpha * orb.display.w;
    return vec4(color * opacity, opacity);
}

@group(0) @binding(0) var painted: texture_2d<f32>;
@group(0) @binding(1) var paint_sampler: sampler;

@fragment
fn composite(in: VertexResult) -> @location(0) vec4<f32> {
    let tex_coord = vec2(in.uv.x, -in.uv.y) * 0.5 + 0.5;
    return textureSample(painted, paint_sampler, tex_coord);
}
