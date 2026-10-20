const MAX_SOURCE_SIDE = 16384;
const MAX_FACE_SIDE = 4096;
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const MAX_LIVE_BYTES = 128 * 1024 * 1024;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_EVALUATIONS = 2 ** 28;
const FACES = ["px", "nx", "py", "ny", "pz", "nz"];
const FUNCTIONS = ["projections_abi_version", "projections_alloc_f32", "projections_free_f32",
  "projections_alloc_f64", "projections_free_f64", "projections_render_region",
  "projections_sample_equirect", "projections_map"];
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

const isTyped = (value, name) => ArrayBuffer.isView(value)
  && Object.prototype.toString.call(value) === `[object ${name}]`;
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
function faceIndex(face) {
  const index = FACES.indexOf(face);
  if (index < 0) throw new RangeError("Native projection needs a valid source cube face");
  return index;
}
function warpIndex(warp) {
  if (warp === "gnomonic") return 0;
  if (warp === "equi-angular") return 1;
  throw new RangeError("Native projection needs a valid cube warp");
}
function image(level, bounded = true) {
  if (!level || !integer(level.width, 1, MAX_SOURCE_SIDE) || !integer(level.height, 1, MAX_SOURCE_SIDE)
    || !isTyped(level.data, "Float32Array") || level.data.length !== level.width * level.height * 3
    || (bounded && level.data.byteLength > MAX_BUFFER_BYTES)) {
    throw new RangeError("Native projection needs a bounded linear RGB image");
  }
  return level;
}
function coordinates(values, stride) {
  if (!isTyped(values, "Float64Array") || values.length === 0 || values.length % stride !== 0
    || values.byteLength > MAX_BUFFER_BYTES) throw new RangeError("Native projection needs bounded complete Float64 coordinates");
  return values;
}
function outputTarget(out) {
  if (!Array.isArray(out) && !((isTyped(out, "Float32Array") || isTyped(out, "Float64Array")) && out.length >= 3)) {
    throw new TypeError("Native projection sample output needs three writable numbers");
  }
}
function operationError(status) {
  switch (status) {
    case 1: return new RangeError("Native projection dimensions exceed the supported bounds");
    case 2: return new RangeError("Native projection buffer lengths do not match the operation");
    case 3: return new Error("Native projection allocation is unavailable or invalid");
    case 4: return new RangeError("Native projection options are invalid");
    default: return new Error(`Native projection returned invalid status: ${String(status)}`);
  }
}

// Explicit little-endian copies also support hosts whose typed arrays use a
// different byte order. Every returned array owns its storage outside WASM.
function copyIn(buffer, pointer, kind, values) {
  if (LITTLE_ENDIAN) {
    const Type = kind === "f32" ? Float32Array : Float64Array;
    new Type(buffer, pointer, values.length).set(values);
  } else {
    const bytes = kind === "f32" ? 4 : 8, view = new DataView(buffer);
    for (let i = 0; i < values.length; i++) {
      if (kind === "f32") view.setFloat32(pointer + i * bytes, values[i], true);
      else view.setFloat64(pointer + i * bytes, values[i], true);
    }
  }
}
function copyOut(buffer, pointer, kind, length) {
  const Type = kind === "f32" ? Float32Array : Float64Array;
  if (LITTLE_ENDIAN) return new Type(new Type(buffer, pointer, length));
  const out = new Type(length), bytes = Type.BYTES_PER_ELEMENT, view = new DataView(buffer);
  for (let i = 0; i < length; i++) out[i] = kind === "f32"
    ? view.getFloat32(pointer + i * bytes, true) : view.getFloat64(pointer + i * bytes, true);
  return out;
}

export function requireProjectionWorker() {
  if (typeof document !== "undefined" || typeof window !== "undefined") {
    throw new Error("Native projection kernels must run in a worker, not on the page");
  }
}

/** Internal raw ABI boundary; importing this module does not instantiate WASM. */
export function createProjectionCore(exports) {
  requireProjectionWorker();
  if (!exports || typeof exports !== "object") throw new Error("Invalid native projection ABI exports");
  for (const name of FUNCTIONS) if (typeof exports[name] !== "function") {
    throw new Error(`Invalid native projection ABI: missing ${name}`);
  }
  const memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Invalid native projection ABI memory");
  const buffer = () => {
    const current = memory.buffer;
    if (!(current instanceof ArrayBuffer) || current.byteLength === 0 || current.byteLength > MAX_MEMORY_BYTES) {
      throw new Error("Native projection memory exceeds the single-core 256 MiB bound or is invalid");
    }
    return current;
  };
  buffer();
  if (exports.projections_abi_version() !== 1) throw new Error("Unsupported native projection ABI version");
  buffer();
  const span = (current, pointer, bytes, alignment) => {
    if (pointer % alignment !== 0 || pointer > current.byteLength || bytes > current.byteLength - pointer) {
      throw new Error("Native projection allocation is misaligned or outside linear memory");
    }
  };

  // Each descriptor is a new owned allocation; even caller subarrays are
  // copied. Refresh memory views after all allocations and after execution.
  function execute(descriptors, run) {
    const allocations = descriptors.map(d => ({ ...d, pointer: 0, bytes: d.length * (d.kind === "f32" ? 4 : 8) }));
    if (allocations.some(d => !integer(d.length, 1, 0xffff_ffff) || d.bytes > MAX_BUFFER_BYTES)
      || allocations.reduce((sum, d) => sum + d.bytes, 0) > MAX_LIVE_BYTES) {
      throw new RangeError("Native projection request exceeds the 128 MiB live buffer bound");
    }
    let failed = false, failure;
    try {
      for (const allocation of allocations) {
        const pointer = exports[`projections_alloc_${allocation.kind}`](allocation.length);
        if (!integer(pointer, 0, 0xffff_ffff)) throw new Error("Native projection allocator returned an invalid pointer");
        if (pointer === 0) throw new Error("Native projection allocation failed");
        allocation.pointer = pointer;
        span(buffer(), pointer, allocation.bytes, allocation.kind === "f32" ? 4 : 8);
      }
      const before = buffer();
      for (let i = 0; i < allocations.length; i++) {
        const a = allocations[i];
        span(before, a.pointer, a.bytes, a.kind === "f32" ? 4 : 8);
        for (let j = 0; j < i; j++) {
          const b = allocations[j];
          if (a.pointer < b.pointer + b.bytes && b.pointer < a.pointer + a.bytes) {
            throw new Error("Native projection allocations overlap");
          }
        }
        if (a.values) copyIn(before, a.pointer, a.kind, a.values);
        if (a.fill) a.fill(before, a.pointer);
      }
      const status = run(allocations.map(d => d.pointer));
      if (status !== 0) throw operationError(status);
      const after = buffer();
      for (const a of allocations) span(after, a.pointer, a.bytes, a.kind === "f32" ? 4 : 8);
      const output = allocations.at(-1);
      return copyOut(after, output.pointer, output.kind, output.length);
    } catch (error) { failed = true; failure = error; throw error; }
    finally {
      // Cleanup failures must stay visible, together with the operation's own failure.
      /* eslint-disable no-unsafe-finally */
      const cleanup = [];
      for (let i = allocations.length - 1; i >= 0; i--) {
        const a = allocations[i];
        if (a.pointer === 0) continue;
        try {
          const status = exports[`projections_free_${a.kind}`](a.pointer, a.length);
          if (status !== 0) throw new Error(`Native projection ${a.kind} release failed (${String(status)})`);
        } catch (error) { cleanup.push(error); }
      }
      if (cleanup.length > 0) {
        if (failed) throw new AggregateError([failure, ...cleanup], "Native projection operation and cleanup failed", { cause: failure });
        throw new AggregateError(cleanup, "Native projection cleanup failed");
      }
      /* eslint-enable no-unsafe-finally */
    }
  }
  function sampleBatch(level, values, mode) {
    image(level); coordinates(values, mode === 0 ? 2 : 3);
    const outputLength = values.length / (mode === 0 ? 2 : 3) * 3;
    return execute([
      { kind: "f32", values: level.data, length: level.data.length },
      { kind: "f64", values, length: values.length },
      { kind: "f64", length: outputLength },
    ], ([source, coords, out]) => exports.projections_sample_equirect(source, level.data.length,
      level.width, level.height, coords, values.length, mode, out, outputLength));
  }
  function mapBatch(values, operation, inputStride, outputStride, face = 0, warp = 0) {
    coordinates(values, inputStride);
    const outputLength = values.length / inputStride * outputStride;
    return execute([
      { kind: "f64", values, length: values.length }, { kind: "f64", length: outputLength },
    ], ([input, out]) => exports.projections_map(input, values.length, operation, face, warp, out, outputLength));
  }

  const preparationStats = { jobs: 0, blocks: 0, copiedBytes: 0, peakLiveBytes: 0, memoryBytes: buffer().byteLength };
  function renderWindowed(request) {
    if (typeof exports.projections_window_bounds !== "function" || typeof exports.projections_render_window !== "function") {
      throw new Error("Native projection binary has no bounded window preparation exports; rebuild projections");
    }
    const { source, face, faceSize, samplesPerAxis, warp, gutter, originX, originY, regionSize } = request;
    const faceNumber = faceIndex(face), warpNumber = warpIndex(warp);
    const args = [source.width, source.height, faceNumber, faceSize, samplesPerAxis, warpNumber, gutter, originX, originY, regionSize];
    const side = regionSize + 2 * gutter;
    const data = new Float32Array(side * side * 3);
    const renderBlock = (x, y, width, height) => {
      const rect = [x, y, width, height];
      const bounds = execute([{ kind: "f64", length: 4 }], ([out]) => exports.projections_window_bounds(...args, ...rect, out, 4));
      const [wx, wy, ww, wh] = bounds;
      if (!integer(wx, 0, source.width - 1) || !integer(wy, 0, source.height - 1)
        || !integer(ww, 1, source.width) || !integer(wh, 1, source.height - wy)) throw new Error("Invalid native projection window bounds");
      const inputLength = ww * wh * 3, outputLength = width * height * 3;
      const liveBytes = (inputLength + outputLength) * 4;
      // Bound live inputs and outputs together. Split the output, never the
      // supersampling grid or accumulation of any one output pixel.
      if (liveBytes > 64 * 1024 * 1024 && (width > 1 || height > 1)) {
        if (width >= height && width > 1) {
          const half = Math.floor(width / 2);
          renderBlock(x, y, half, height); renderBlock(x + half, y, width - half, height);
        } else {
          const half = Math.floor(height / 2);
          renderBlock(x, y, width, half); renderBlock(x, y + half, width, height - half);
        }
        return;
      }
      const result = execute([
        { kind: "f32", length: inputLength, fill(current, pointer) {
          const first = Math.min(ww, source.width - wx);
          for (let row = 0; row < wh; row++) {
            const offset = ((wy + row) * source.width + wx) * 3;
            const target = pointer + row * ww * 12;
            copyIn(current, target, "f32", source.data.subarray(offset, offset + first * 3));
            if (first < ww) {
              const wrapped = (wy + row) * source.width * 3;
              copyIn(current, target + first * 12, "f32", source.data.subarray(wrapped, wrapped + (ww - first) * 3));
            }
          }
        } },
        { kind: "f32", length: outputLength },
      ], ([input, out]) => exports.projections_render_window(input, inputLength, source.width, source.height,
        wx, wy, ww, wh, faceNumber, faceSize, samplesPerAxis, warpNumber, gutter, originX, originY,
        regionSize, ...rect, out, outputLength));
      for (let row = 0; row < height; row++) data.set(result.subarray(row * width * 3, (row + 1) * width * 3), ((y + row) * side + x) * 3);
      preparationStats.blocks++;
      preparationStats.copiedBytes += (inputLength + 2 * outputLength) * 4;
      preparationStats.peakLiveBytes = Math.max(preparationStats.peakLiveBytes, liveBytes);
      preparationStats.memoryBytes = Math.max(preparationStats.memoryBytes, buffer().byteLength);
    };
    // Start with bounded output rectangles. Tiny region jobs stay one job;
    // normal large faces do not scan their entire sample grid before copying.
    for (let y = 0; y < side; y += 256) for (let x = 0; x < side; x += 256) {
      renderBlock(x, y, Math.min(256, side - x), Math.min(256, side - y));
    }
    preparationStats.jobs++;
    return { width: side, height: side, data };
  }

  return {
    preparationStats() { return { ...preparationStats }; },
    actualTier: "single",
    validationStatus: "unvalidated",
    renderEquirectRegion(request) {
      if (!request || typeof request !== "object") throw new TypeError("Native projection needs a cube region request");
      const { source, face, faceSize, samplesPerAxis, warp, gutter, originX, originY, regionSize } = request;
      image(source, false);
      faceIndex(face); warpIndex(warp);
      if (!integer(faceSize, 1, MAX_FACE_SIDE) || !integer(regionSize, 1, faceSize)
        || !integer(originX, 0, faceSize - regionSize) || !integer(originY, 0, faceSize - regionSize)
        || !integer(gutter, 0, MAX_FACE_SIDE) || !integer(samplesPerAxis, 1, 8)) {
        throw new RangeError("Native projection needs bounded whole face, region, gutter and sample dimensions");
      }
      const side = regionSize + 2 * gutter;
      if (side > MAX_FACE_SIDE || side * side * samplesPerAxis * samplesPerAxis > MAX_EVALUATIONS) {
        throw new RangeError("Native projection region exceeds the bounded sample workload");
      }
      return renderWindowed(request);
    },
    /** Retained whole-source ABI reference for bounded inputs and parity checks. */
    renderEquirectRegionWhole(request) {
      const { source, face, faceSize, samplesPerAxis, warp, gutter, originX, originY, regionSize } = request;
      image(source);
      const faceNumber = faceIndex(face), warpNumber = warpIndex(warp);
      const side = regionSize + 2 * gutter, outputLength = side * side * 3;
      const data = execute([
        { kind: "f32", values: source.data, length: source.data.length }, { kind: "f32", length: outputLength },
      ], ([input, out]) => exports.projections_render_region(input, source.data.length, source.width,
        source.height, faceNumber, faceSize, samplesPerAxis, warpNumber, gutter, originX, originY,
        regionSize, out, outputLength));
      return { width: side, height: side, data };
    },
    sampleEquirectBatch(level, uv) { return sampleBatch(level, uv, 0); },
    sampleDirectionBatch(level, xyz) { return sampleBatch(level, xyz, 1); },
    sampleEquirect(level, u, v, out) {
      outputTarget(out);
      const colour = sampleBatch(level, new Float64Array([u, v]), 0);
      out[0] = colour[0]; out[1] = colour[1]; out[2] = colour[2];
    },
    sampleDirection(level, x, y, z, out) {
      outputTarget(out);
      const colour = sampleBatch(level, new Float64Array([x, y, z]), 1);
      out[0] = colour[0]; out[1] = colour[1]; out[2] = colour[2];
    },
    equirectUvBatch(xyz) { return mapBatch(xyz, 0, 3, 2); },
    equirectDirectionBatch(uv) { return mapBatch(uv, 1, 2, 3); },
    equirectCoordinatesBatch(xyz) { return mapBatch(xyz, 2, 3, 2); },
    sourceCubeDirectionBatch(face, uv) { return mapBatch(uv, 3, 2, 3, faceIndex(face)); },
    sourceCubeLookupBatch(xyz) { return mapBatch(xyz, 4, 3, 3); },
    cubeTilingDirectionBatch(face, uv, warp) { return mapBatch(uv, 5, 2, 3, faceIndex(face), warpIndex(warp)); },
    cubeTilingLocateBatch(xyz, warp) { return mapBatch(xyz, 6, 3, 3, 0, warpIndex(warp)); },
  };
}
