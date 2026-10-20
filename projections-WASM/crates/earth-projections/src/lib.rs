//! Single-threaded sphere projection ABI. Buffers are instance-owned registry
//! entries: incoming pointers are matched against live typed allocations and
//! are never dereferenced directly. Math imports deliberately use the caller's
//! JavaScript realm, matching the TypeScript reference's transcendental calls.
//! Compiled for WASM; functional parity and lifecycle validation remain pending.

use std::cell::RefCell;
use std::mem::size_of;

const ABI_VERSION: u32 = 1;
const MAX_SOURCE_SIDE: u32 = 16_384;
const MAX_FACE_SIDE: u32 = 4096;
const MAX_SAMPLES: u32 = 8;
const MAX_EVALUATIONS: u64 = 1 << 28;
const MAX_BUFFER_BYTES: usize = 128 * 1024 * 1024;
const MAX_LIVE_BYTES: usize = 128 * 1024 * 1024;
const MAX_LIVE_BUFFERS: usize = 64;
const PI: f64 = std::f64::consts::PI;

#[derive(Clone, Copy)]
#[repr(u32)]
enum Error {
    Dimensions = 1,
    Length = 2,
    Allocation = 3,
    Options = 4,
}
type Result<T> = std::result::Result<T, Error>;

#[cfg(target_arch = "wasm32")]
mod math {
    #[link(wasm_import_module = "math")]
    unsafe extern "C" {
        pub fn atan2(y: f64, x: f64) -> f64;
        pub fn asin(x: f64) -> f64;
        pub fn atan(x: f64) -> f64;
        pub fn tan(x: f64) -> f64;
        pub fn sin(x: f64) -> f64;
        pub fn cos(x: f64) -> f64;
        pub fn sqrt(x: f64) -> f64;
    }
}

// Host compilation can inspect the kernels, but exact JavaScript parity is a
// property of the WASM build with the imported executing-realm Math functions.
#[cfg(not(target_arch = "wasm32"))]
mod math {
    pub unsafe fn atan2(y: f64, x: f64) -> f64 {
        y.atan2(x)
    }
    pub unsafe fn asin(x: f64) -> f64 {
        x.asin()
    }
    pub unsafe fn atan(x: f64) -> f64 {
        x.atan()
    }
    pub unsafe fn tan(x: f64) -> f64 {
        x.tan()
    }
    pub unsafe fn sin(x: f64) -> f64 {
        x.sin()
    }
    pub unsafe fn cos(x: f64) -> f64 {
        x.cos()
    }
    pub unsafe fn sqrt(x: f64) -> f64 {
        x.sqrt()
    }
}

// Rust min/max discard a single NaN; JavaScript Math.min/max propagate it and
// distinguish signed zero. Keep the reference's operand order explicitly.
fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() || b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else if a < b {
        a
    } else {
        b
    }
}
fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() || b.is_sign_positive() {
            0.0
        } else {
            -0.0
        }
    } else if a > b {
        a
    } else {
        b
    }
}

// Same arithmetic hypot3 used by the preparation sources, including its
// compensation and overflow/NaN order. Do not replace with an intrinsic hypot.
fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    let a = x.abs();
    let b = y.abs();
    let c = z.abs();
    if a == f64::INFINITY || b == f64::INFINITY || c == f64::INFINITY {
        return f64::INFINITY;
    }
    let largest = max(max(a, b), c);
    if largest.is_nan() {
        return f64::NAN;
    }
    if largest == 0.0 {
        return 0.0;
    }
    let power_a = (a / largest) * (a / largest);
    let power_b = (b / largest) * (b / largest);
    let compensation = ((power_a + power_b) - power_a) - power_b;
    let power_c = (c / largest) * (c / largest) - compensation;
    unsafe { math::sqrt((power_a + power_b) + power_c) * largest }
}

fn uv(x: f64, y: f64, z: f64) -> [f64; 2] {
    let n = hypot3(x, y, z);
    unsafe {
        [
            0.5 + math::atan2(x, y) / (2.0 * PI),
            0.5 - math::asin(max(-1.0, min(1.0, z / n))) / PI,
        ]
    }
}

// SOURCE_CUBE_FACES, in public px,nx,py,ny,pz,nz order: forward,right,top.
const FACES: [[[f64; 3]; 3]; 6] = [
    [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]],
    [[-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
    [[0.0, -1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
    [[0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, -1.0, 0.0]],
    [[0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
];
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    (a[0] * b[0] + a[1] * b[1]) + a[2] * b[2]
}
fn normalized(d: [f64; 3]) -> [f64; 3] {
    let n = unsafe { 1.0 / math::sqrt(dot(d, d)) };
    [d[0] * n, d[1] * n, d[2] * n]
}

fn image_len(width: u32, height: u32) -> Result<usize> {
    if width == 0 || height == 0 || width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE {
        return Err(Error::Dimensions);
    }
    let len = width as u64 * height as u64 * 3;
    if len * 4 > MAX_BUFFER_BYTES as u64 {
        return Err(Error::Dimensions);
    }
    Ok(len as usize)
}

// Bilinear samples stay f64 until the caller's final store. For a nonfinite
// longitude/NaN latitude, JS indexing reads undefined and produces NaN. Handle
// that case before converting an index to usize, so it cannot alias pixel zero.
fn sample(src: &[f32], width: u32, height: u32, u: f64, v: f64) -> [f64; 3] {
    let w = f64::from(width);
    let h = f64::from(height);
    let fx = u * w - 0.5;
    let fy = min(h - 1.0, max(0.0, v * h - 0.5));
    let x0 = fx.floor();
    let y0 = fy.floor();
    if !x0.is_finite() || !y0.is_finite() {
        return [f64::NAN; 3];
    }
    let tx = fx - x0;
    let ty = fy - y0;
    let y1 = min(h - 1.0, y0 + 1.0) as usize;
    let xa = (((x0 % w) + w) % w) as usize;
    let xb = (xa + 1) % width as usize;
    let y0 = y0 as usize;
    let p00 = (y0 * width as usize + xa) * 3;
    let p01 = (y0 * width as usize + xb) * 3;
    let p10 = (y1 * width as usize + xa) * 3;
    let p11 = (y1 * width as usize + xb) * 3;
    let mut out = [0.0; 3];
    for c in 0..3 {
        let top = f64::from(src[p00 + c]) * (1.0 - tx) + f64::from(src[p01 + c]) * tx;
        let bottom = f64::from(src[p10 + c]) * (1.0 - tx) + f64::from(src[p11 + c]) * tx;
        out[c] = top * (1.0 - ty) + bottom * ty;
    }
    out
}

#[derive(Clone, Copy)]
struct Region {
    face: u32,
    size: u32,
    samples: u32,
    warp: u32,
    gutter: u32,
    x: u32,
    y: u32,
    region_size: u32,
}
impl Region {
    fn output_len(self) -> Result<usize> {
        if self.face >= 6 || self.warp > 1 || self.samples == 0 || self.samples > MAX_SAMPLES {
            return Err(Error::Options);
        }
        if self.size == 0
            || self.size > MAX_FACE_SIDE
            || self.region_size == 0
            || self.region_size > self.size
            || self.x > self.size - self.region_size
            || self.y > self.size - self.region_size
            || self.gutter > MAX_FACE_SIDE
        {
            return Err(Error::Dimensions);
        }
        let side = self.region_size as u64 + 2 * self.gutter as u64;
        let count = side * side;
        if side > MAX_FACE_SIDE as u64
            || count * 12 > MAX_BUFFER_BYTES as u64
            || count * self.samples as u64 * self.samples as u64 > MAX_EVALUATIONS
        {
            return Err(Error::Dimensions);
        }
        Ok(count as usize * 3)
    }
}

fn render(src: &[f32], width: u32, height: u32, region: Region, out: &mut [f32]) {
    let [f, r, t] = FACES[region.face as usize];
    let side = region.region_size + 2 * region.gutter;
    let size = f64::from(region.size);
    let samples = f64::from(region.samples);
    for j in 0..side {
        for i in 0..side {
            let mut red = 0.0;
            let mut green = 0.0;
            let mut blue = 0.0;
            for sj in 0..region.samples {
                for si in 0..region.samples {
                    let mut a = 2.0
                        * (((f64::from(region.x) + f64::from(i) - f64::from(region.gutter))
                            + (f64::from(si) + 0.5) / samples)
                            / size)
                        - 1.0;
                    let mut b = 1.0
                        - 2.0
                            * (((f64::from(region.y) + f64::from(j) - f64::from(region.gutter))
                                + (f64::from(sj) + 0.5) / samples)
                                / size);
                    if region.warp == 1 {
                        unsafe {
                            a = math::tan(a * PI / 4.0);
                            b = math::tan(b * PI / 4.0);
                        }
                    }
                    let x = (f[0] + a * r[0]) + b * t[0];
                    let y = (f[1] + a * r[1]) + b * t[1];
                    let z = (f[2] + a * r[2]) + b * t[2];
                    let [u, v] = uv(x, y, z);
                    let colour = sample(src, width, height, u, v);
                    red += colour[0];
                    green += colour[1];
                    blue += colour[2];
                }
            }
            let d = (j as usize * side as usize + i as usize) * 3;
            let count = samples * samples;
            out[d] = (red / count) as f32;
            out[d + 1] = (green / count) as f32;
            out[d + 2] = (blue / count) as f32;
        }
    }
}

// Bounded source windows use global coordinates: no change to sample spacing,
// longitude wrapping, latitude clamping or f64 arithmetic. Output rectangles
// retain the original region's i/j, including gutters.
#[derive(Clone, Copy)]
struct Block {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}
fn block_len(region: Region, block: Block) -> Result<usize> {
    region.output_len()?;
    let side = region.region_size + 2 * region.gutter;
    if block.width == 0
        || block.height == 0
        || block.width > side
        || block.height > side
        || block.x > side - block.width
        || block.y > side - block.height
    {
        return Err(Error::Dimensions);
    }
    Ok(block.width as usize * block.height as usize * 3)
}
fn region_uv(region: Region, i: u32, j: u32, si: u32, sj: u32) -> [f64; 2] {
    let [f, r, t] = FACES[region.face as usize];
    let size = f64::from(region.size);
    let samples = f64::from(region.samples);
    let mut a = 2.0
        * (((f64::from(region.x) + f64::from(i) - f64::from(region.gutter))
            + (f64::from(si) + 0.5) / samples)
            / size)
        - 1.0;
    let mut b = 1.0
        - 2.0
            * (((f64::from(region.y) + f64::from(j) - f64::from(region.gutter))
                + (f64::from(sj) + 0.5) / samples)
                / size);
    if region.warp == 1 {
        unsafe {
            a = math::tan(a * PI / 4.0);
            b = math::tan(b * PI / 4.0);
        }
    }
    uv(
        (f[0] + a * r[0]) + b * t[0],
        (f[1] + a * r[1]) + b * t[1],
        (f[2] + a * r[2]) + b * t[2],
    )
}
fn source_dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 || width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE {
        return Err(Error::Dimensions);
    }
    Ok(())
}
fn window_bounds(width: u32, height: u32, region: Region, block: Block) -> Result<[u32; 4]> {
    source_dimensions(width, height)?;
    block_len(region, block)?;
    let w = f64::from(width);
    let h = f64::from(height);
    let first = region_uv(region, block.x, block.y, 0, 0);
    let anchor = (first[0] * w - 0.5).floor();
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = h;
    let mut max_y: f64 = 0.0;
    for j in block.y..block.y + block.height {
        for i in block.x..block.x + block.width {
            for sj in 0..region.samples {
                for si in 0..region.samples {
                    let [u, v] = region_uv(region, i, j, si, sj);
                    let x = (u * w - 0.5).floor();
                    let y = min(h - 1.0, max(0.0, v * h - 0.5)).floor();
                    if !x.is_finite() || !y.is_finite() {
                        return Err(Error::Options);
                    }
                    // A circular interval about the first tap. Include both taps
                    // before wrapping so the antimeridian remains contiguous.
                    let x = x - ((x - anchor + w / 2.0) / w).floor() * w;
                    min_x = min(min_x, x);
                    max_x = max(max_x, x + 1.0);
                    min_y = min(min_y, y);
                    max_y = max(max_y, min(h - 1.0, y + 1.0));
                }
            }
        }
    }
    let window_width = min(w, max_x - min_x + 1.0) as u32;
    let start_x = (((min_x % w) + w) % w) as u32;
    Ok([
        start_x,
        min_y as u32,
        window_width,
        (max_y - min_y + 1.0) as u32,
    ])
}
fn sample_window(
    src: &[f32],
    width: u32,
    height: u32,
    window: [u32; 4],
    u: f64,
    v: f64,
) -> Result<[f64; 3]> {
    let w = f64::from(width);
    let h = f64::from(height);
    let fx = u * w - 0.5;
    let fy = min(h - 1.0, max(0.0, v * h - 0.5));
    let x0 = fx.floor();
    let y0 = fy.floor();
    if !x0.is_finite() || !y0.is_finite() {
        return Ok([f64::NAN; 3]);
    }
    let tx = fx - x0;
    let ty = fy - y0;
    let xa = (((x0 % w) + w) % w) as u32;
    let xb = (xa + 1) % width;
    let ya = y0 as u32;
    let yb = min(h - 1.0, y0 + 1.0) as u32;
    let index = |x: u32, y: u32| -> Result<usize> {
        let x = (x + width - window[0]) % width;
        if x >= window[2] || y < window[1] || y - window[1] >= window[3] {
            return Err(Error::Length);
        }
        Ok(((y - window[1]) as usize * window[2] as usize + x as usize) * 3)
    };
    let p00 = index(xa, ya)?;
    let p01 = index(xb, ya)?;
    let p10 = index(xa, yb)?;
    let p11 = index(xb, yb)?;
    let mut out = [0.0; 3];
    for c in 0..3 {
        let top = f64::from(src[p00 + c]) * (1.0 - tx) + f64::from(src[p01 + c]) * tx;
        let bottom = f64::from(src[p10 + c]) * (1.0 - tx) + f64::from(src[p11 + c]) * tx;
        out[c] = top * (1.0 - ty) + bottom * ty;
    }
    Ok(out)
}
fn render_window(
    src: &[f32],
    width: u32,
    height: u32,
    window: [u32; 4],
    region: Region,
    block: Block,
    out: &mut [f32],
) -> Result<()> {
    for j in 0..block.height {
        for i in 0..block.width {
            let mut red = 0.0;
            let mut green = 0.0;
            let mut blue = 0.0;
            for sj in 0..region.samples {
                for si in 0..region.samples {
                    let [u, v] = region_uv(region, block.x + i, block.y + j, si, sj);
                    let colour = sample_window(src, width, height, window, u, v)?;
                    red += colour[0];
                    green += colour[1];
                    blue += colour[2];
                }
            }
            let d = (j as usize * block.width as usize + i as usize) * 3;
            let count = f64::from(region.samples) * f64::from(region.samples);
            out[d] = (red / count) as f32;
            out[d + 1] = (green / count) as f32;
            out[d + 2] = (blue / count) as f32;
        }
    }
    Ok(())
}

// Map operations: 0 preparation xyz->uv (hypot), 1 equirect uv->xyz,
// 2 core xyz->uv (sqrt normalization), 3 source cube uv->xyz,
// 4 source cube xyz->face,uv, 5 tiled cube uv->xyz, 6 tiled xyz->face,uv.
fn map_shape(operation: u32, len: usize, face: u32, warp: u32) -> Result<usize> {
    if operation > 6
        || (matches!(operation, 3 | 5) && face >= 6)
        || (matches!(operation, 5 | 6) && warp > 1)
    {
        return Err(Error::Options);
    }
    let (input, output) = match operation {
        0 | 2 => (3, 2),
        1 | 3 | 5 => (2, 3),
        _ => (3, 3),
    };
    if len == 0 || len % input != 0 {
        return Err(Error::Length);
    }
    let output_len = (len / input).checked_mul(output).ok_or(Error::Length)?;
    if output_len > MAX_BUFFER_BYTES / 8 {
        return Err(Error::Length);
    }
    Ok(output_len)
}

fn map(input: &[f64], operation: u32, face: u32, warp: u32, out: &mut [f64]) {
    let input_size = if matches!(operation, 1 | 3 | 5) { 2 } else { 3 };
    let output_size = if matches!(operation, 0 | 2) { 2 } else { 3 };
    for (v, dst) in input
        .chunks_exact(input_size)
        .zip(out.chunks_exact_mut(output_size))
    {
        match operation {
            0 => dst.copy_from_slice(&uv(v[0], v[1], v[2])),
            1 => {
                let theta = 2.0 * PI * (v[0] - 0.5);
                let phi = PI * (0.5 - v[1]);
                unsafe {
                    dst.copy_from_slice(&[
                        math::sin(theta) * math::cos(phi),
                        math::cos(theta) * math::cos(phi),
                        math::sin(phi),
                    ]);
                }
            }
            2 => {
                let d = normalized([v[0], v[1], v[2]]);
                unsafe {
                    dst.copy_from_slice(&[
                        0.5 + math::atan2(d[0], d[1]) / (2.0 * PI),
                        0.5 - math::asin(max(-1.0, min(1.0, d[2]))) / PI,
                    ]);
                }
            }
            3 | 5 => {
                let [f, r, t] = FACES[face as usize];
                let mut a = 2.0 * v[0] - 1.0;
                let mut b = 1.0 - 2.0 * v[1];
                if operation == 5 && warp == 1 {
                    unsafe {
                        a = math::tan(a * (PI / 4.0));
                        b = math::tan(b * (PI / 4.0));
                    }
                }
                let mut d = [0.0; 3];
                for c in 0..3 {
                    // core add(f,add(scale(r,a),scale(t,b))) has a different
                    // grouping from cubeTiling.direction and preparation.
                    d[c] = if operation == 3 {
                        f[c] + (r[c] * a + t[c] * b)
                    } else {
                        (f[c] + a * r[c]) + b * t[c]
                    };
                }
                dst.copy_from_slice(&normalized(d));
            }
            4 | 6 => {
                let d = [v[0], v[1], v[2]];
                let mut chosen = 0;
                let mut depth = f64::NEG_INFINITY;
                if operation == 4 {
                    for (index, basis) in FACES.iter().enumerate() {
                        let candidate = dot(d, basis[0]);
                        if candidate > depth {
                            chosen = index;
                            depth = candidate;
                        }
                    }
                } else {
                    let ax = v[0].abs();
                    let ay = v[1].abs();
                    let az = v[2].abs();
                    chosen = if ax >= ay && ax >= az {
                        if v[0] > 0.0 { 0 } else { 1 }
                    } else if ay >= az {
                        if v[1] > 0.0 { 2 } else { 3 }
                    } else if v[2] > 0.0 {
                        4
                    } else {
                        5
                    };
                    depth = dot(d, FACES[chosen][0]);
                }
                let mut a = dot(d, FACES[chosen][1]) / depth;
                let mut b = dot(d, FACES[chosen][2]) / depth;
                if operation == 6 && warp == 1 {
                    unsafe {
                        a = math::atan(a) / (PI / 4.0);
                        b = math::atan(b) / (PI / 4.0);
                    }
                }
                dst.copy_from_slice(&[chosen as f64, (a + 1.0) / 2.0, (1.0 - b) / 2.0]);
            }
            _ => unreachable!(),
        }
    }
}

#[derive(Default)]
struct Registry {
    f32s: Vec<Vec<f32>>,
    f64s: Vec<Vec<f64>>,
    live_bytes: usize,
}
fn allocate<T: Default + Clone>(buffers: &mut Vec<Vec<T>>, len: usize) -> usize {
    if buffers.try_reserve(1).is_err() {
        return 0;
    }
    let mut data = Vec::new();
    if data.try_reserve_exact(len).is_err() {
        return 0;
    }
    data.resize(len, T::default());
    let pointer = data.as_ptr() as usize;
    buffers.push(data);
    pointer
}
fn free<T>(buffers: &mut Vec<Vec<T>>, pointer: usize, len: usize) -> Result<()> {
    let index = buffers
        .iter()
        .position(|v| v.as_ptr() as usize == pointer && v.len() == len)
        .ok_or(Error::Allocation)?;
    buffers.swap_remove(index);
    Ok(())
}
fn find<T>(buffers: &[Vec<T>], pointer: usize, len: usize) -> Result<&[T]> {
    buffers
        .iter()
        .find(|v| v.as_ptr() as usize == pointer && v.len() == len)
        .map(Vec::as_slice)
        .ok_or(Error::Allocation)
}
fn pair<T>(
    buffers: &mut [Vec<T>],
    input: usize,
    input_len: usize,
    output: usize,
    output_len: usize,
) -> Result<(&[T], &mut [T])> {
    let a = buffers
        .iter()
        .position(|v| v.as_ptr() as usize == input && v.len() == input_len)
        .ok_or(Error::Allocation)?;
    let b = buffers
        .iter()
        .position(|v| v.as_ptr() as usize == output && v.len() == output_len)
        .ok_or(Error::Allocation)?;
    if a == b {
        return Err(Error::Allocation);
    }
    if a < b {
        let (left, right) = buffers.split_at_mut(b);
        Ok((&left[a], &mut right[0]))
    } else {
        let (left, right) = buffers.split_at_mut(a);
        Ok((&right[0], &mut left[b]))
    }
}
impl Registry {
    fn alloc(&mut self, kind: u32, len: u32) -> usize {
        let Some(bytes) = (len as usize).checked_mul(if kind == 0 {
            size_of::<f32>()
        } else {
            size_of::<f64>()
        }) else {
            return 0;
        };
        if len == 0
            || bytes > MAX_BUFFER_BYTES
            || self.f32s.len() + self.f64s.len() >= MAX_LIVE_BUFFERS
            || self
                .live_bytes
                .checked_add(bytes)
                .is_none_or(|n| n > MAX_LIVE_BYTES)
        {
            return 0;
        }
        let pointer = if kind == 0 {
            allocate(&mut self.f32s, len as usize)
        } else {
            allocate(&mut self.f64s, len as usize)
        };
        if pointer != 0 {
            self.live_bytes += bytes;
        }
        pointer
    }
    fn free(&mut self, kind: u32, pointer: usize, len: u32) -> Result<()> {
        if kind == 0 {
            free(&mut self.f32s, pointer, len as usize)?;
        } else {
            free(&mut self.f64s, pointer, len as usize)?;
        }
        self.live_bytes -= len as usize * if kind == 0 { 4 } else { 8 };
        Ok(())
    }
}
thread_local! { static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }
fn with_registry<T>(failure: T, run: impl FnOnce(&mut Registry) -> T) -> T {
    REGISTRY.with(|registry| match registry.try_borrow_mut() {
        Ok(mut registry) => run(&mut registry),
        Err(_) => failure,
    })
}
fn status(run: impl FnOnce(&mut Registry) -> Result<()>) -> u32 {
    with_registry(Error::Allocation as u32, |registry| {
        run(registry).map_or_else(|e| e as u32, |()| 0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn projections_abi_version() -> u32 {
    ABI_VERSION
}
#[unsafe(no_mangle)]
pub extern "C" fn projections_alloc_f32(len: u32) -> usize {
    with_registry(0, |r| r.alloc(0, len))
}
#[unsafe(no_mangle)]
pub extern "C" fn projections_alloc_f64(len: u32) -> usize {
    with_registry(0, |r| r.alloc(1, len))
}
#[unsafe(no_mangle)]
pub extern "C" fn projections_free_f32(pointer: usize, len: u32) -> u32 {
    status(|r| r.free(0, pointer, len))
}
#[unsafe(no_mangle)]
pub extern "C" fn projections_free_f64(pointer: usize, len: u32) -> u32 {
    status(|r| r.free(1, pointer, len))
}

#[unsafe(no_mangle)]
pub extern "C" fn projections_render_region(
    src: usize,
    src_len: u32,
    width: u32,
    height: u32,
    face: u32,
    size: u32,
    samples: u32,
    warp: u32,
    gutter: u32,
    x: u32,
    y: u32,
    region_size: u32,
    out: usize,
    out_len: u32,
) -> u32 {
    status(|registry| {
        let region = Region {
            face,
            size,
            samples,
            warp,
            gutter,
            x,
            y,
            region_size,
        };
        if src_len as usize != image_len(width, height)?
            || out_len as usize != region.output_len()?
        {
            return Err(Error::Length);
        }
        let (source, output) = pair(
            &mut registry.f32s,
            src,
            src_len as usize,
            out,
            out_len as usize,
        )?;
        render(source, width, height, region, output);
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn projections_sample_equirect(
    src: usize,
    src_len: u32,
    width: u32,
    height: u32,
    coords: usize,
    coords_len: u32,
    mode: u32,
    out: usize,
    out_len: u32,
) -> u32 {
    status(|registry| {
        if mode > 1 {
            return Err(Error::Options);
        }
        let stride = if mode == 0 { 2 } else { 3 };
        if src_len as usize != image_len(width, height)?
            || coords_len == 0
            || coords_len % stride != 0
            || u64::from(out_len) != u64::from(coords_len / stride) * 3
        {
            return Err(Error::Length);
        }
        let source = find(&registry.f32s, src, src_len as usize)?;
        let (coords, output) = pair(
            &mut registry.f64s,
            coords,
            coords_len as usize,
            out,
            out_len as usize,
        )?;
        for (v, dst) in coords
            .chunks_exact(stride as usize)
            .zip(output.chunks_exact_mut(3))
        {
            let coord = if mode == 0 {
                [v[0], v[1]]
            } else {
                uv(v[0], v[1], v[2])
            };
            dst.copy_from_slice(&sample(source, width, height, coord[0], coord[1]));
        }
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn projections_map(
    input: usize,
    input_len: u32,
    operation: u32,
    face: u32,
    warp: u32,
    out: usize,
    out_len: u32,
) -> u32 {
    status(|registry| {
        if out_len as usize != map_shape(operation, input_len as usize, face, warp)? {
            return Err(Error::Length);
        }
        let (input, output) = pair(
            &mut registry.f64s,
            input,
            input_len as usize,
            out,
            out_len as usize,
        )?;
        map(input, operation, face, warp, output);
        Ok(())
    })
}

// Additive ABI v1 exports. Older binaries remain usable for bounded whole
// sources; wrappers require these exports only for windowed preparation.
#[unsafe(no_mangle)]
pub extern "C" fn projections_window_bounds(
    width: u32,
    height: u32,
    face: u32,
    size: u32,
    samples: u32,
    warp: u32,
    gutter: u32,
    x: u32,
    y: u32,
    region_size: u32,
    bx: u32,
    by: u32,
    bw: u32,
    bh: u32,
    out: usize,
    out_len: u32,
) -> u32 {
    status(|registry| {
        if out_len != 4 {
            return Err(Error::Length);
        }
        let bounds = window_bounds(
            width,
            height,
            Region {
                face,
                size,
                samples,
                warp,
                gutter,
                x,
                y,
                region_size,
            },
            Block {
                x: bx,
                y: by,
                width: bw,
                height: bh,
            },
        )?;
        let output = registry
            .f64s
            .iter_mut()
            .find(|v| v.as_ptr() as usize == out && v.len() == 4)
            .ok_or(Error::Allocation)?;
        for (dst, value) in output.iter_mut().zip(bounds) {
            *dst = f64::from(value);
        }
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn projections_render_window(
    src: usize,
    src_len: u32,
    width: u32,
    height: u32,
    wx: u32,
    wy: u32,
    ww: u32,
    wh: u32,
    face: u32,
    size: u32,
    samples: u32,
    warp: u32,
    gutter: u32,
    x: u32,
    y: u32,
    region_size: u32,
    bx: u32,
    by: u32,
    bw: u32,
    bh: u32,
    out: usize,
    out_len: u32,
) -> u32 {
    status(|registry| {
        source_dimensions(width, height)?;
        if wx >= width
            || wy >= height
            || ww == 0
            || ww > width
            || wh == 0
            || wh > height - wy
            || src_len as usize != image_len(ww, wh)?
        {
            return Err(Error::Length);
        }
        let region = Region {
            face,
            size,
            samples,
            warp,
            gutter,
            x,
            y,
            region_size,
        };
        let block = Block {
            x: bx,
            y: by,
            width: bw,
            height: bh,
        };
        if out_len as usize != block_len(region, block)? {
            return Err(Error::Length);
        }
        let (source, output) = pair(
            &mut registry.f32s,
            src,
            src_len as usize,
            out,
            out_len as usize,
        )?;
        render_window(
            source,
            width,
            height,
            [wx, wy, ww, wh],
            region,
            block,
            output,
        )
    })
}
