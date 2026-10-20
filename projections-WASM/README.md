# projections-WASM

The Rust twin of the sphere preparation libraries' reprojection kernels,
re-exported as [projections-TS](../projections-TS/index.js): `sphere-equirectangular`'s
sampling and `cubePreparationPlan`, `sphere-cubemap`'s `renderCubeFace` and
`sphere-tiled-cubemap`'s `renderCubeTile`. Sphere preparation selects it with
`--native-tier single`; JavaScript remains the default. Importing performs no
fetch, compilation or worker creation.

The kernels operate on the preparation libraries' **linear Float32 RGB**
images, after image decoding, orientation and colour conversion. They are not
RGBA8 codec replacements. They include:

- Bounded-window cubemap face reprojection from an equirectangular pyramid
  level, preserving 8192×4096 source detail without placing its 384 MiB in WASM.
- Gnomonic and equi-angular face regions, including per-tile coordinates and
  exterior gutters, with the existing supersampled bilinear sampling order.
- Batched bilinear equirectangular samples from UV coordinates or directions.
- Batched equirectangular direction/coordinates, preparation direction-to-UV,
  source cube direction/lookup, and tiled cube direction/locate conversions.

Image pyramids, prefilter selection, tile scheduling, coverage intersections,
GPU upload and rendering remain JavaScript. Coordinate batch APIs use
interleaved Float64Array input and output; lookup outputs are
`[faceIndex,u,v]`, with face order `px,nx,py,ny,pz,nz`. Arithmetic stays f64
until the reference's final Float32 store. WASM imports the executing realm's
`Math.atan2`, `asin`, `atan`, `tan`, `sin`, `cos` and `sqrt`; preparation
normalization follows the reference's explicit compensated three-term hypot,
and core coordinate normalization keeps its original sqrt/dot order.

## Use

```js
// In a worker.
import { loadProjectionCore } from "@foss-earth/sphere-image/projections-WASM";
import { cubePreparationPlan, renderCubeFace, renderCubeTile } from "@foss-earth/sphere-image/projections-TS";

const core = await loadProjectionCore();
const plan = cubePreparationPlan(pyramid, faceSize);
const face = renderCubeFace(plan, "px", faceSize, core);
const tile = renderCubeTile(plan, "px", faceSize, "equi-angular", 2, 256, 0, 0, core);
```

Omit the last `core` argument to use the original JavaScript loop. Passing a
core selects the native operation explicitly; unsupported sources, bounds, load
failures and traps throw rather than silently selecting JavaScript. The bulk
ports require the equirectangular level carried by `cubePreparationPlan`;
arbitrary custom sampler functions are not serializable native kernels.
`sampleEquirect`, `createEquirectSourceSampler` and `cubePreparationPlan` also
accept the core as their last optional argument. Supplying the sampling port
alone does not change a bulk renderer's default implementation.

`instantiateProjectionCore(bytes)` creates an independent single-threaded
instance without fetching, for a worker that receives bytes from its owner.
`loadProjectionCore()` lazily fetches `single/projections.wasm` beside the
wrapper and caches its promise; a failed cached load stays failed for that
module instance. `@foss-earth/sphere-image/projections-WASM/wasm` identifies
the binary for external adapters. The browser page is rejected by the wrapper;
inject the core from an owning worker. It reports `actualTier: single` and
`validationStatus: unvalidated`. No backend is substituted on failure.

## Sphere preparation

The `foss-earth-prepare-panorama` command and `prepareSphereAsync` run
`typescript-worker` and `single` in one owning Node worker. It reads and
decodes the source and builds the pyramid there once, without cloning a full
image per face or worker. `single` loads this folder's core;
`--projection-module path` names another build of `projections-WASM/index.js`.
Keep the same input, options, encoder and workers for both arms:

```sh
node node/prepare-cli.mjs --input photograph.jpg --pose pose.json --attribution "Photographer" --preview-face-sizes 256 --tiles eac,cube --tile-size 256 --tile-face-size 2048 --native-tier typescript-worker --out build/projections-js
node node/prepare-cli.mjs --input photograph.jpg --pose pose.json --attribution "Photographer" --preview-face-sizes 256 --tiles eac,cube --tile-size 256 --tile-face-size 2048 --native-tier single --out build/projections-wasm
```

For those face and tile settings, `photograph.jpg` must be at least 8192×4096
and full-sphere, with the existing explicit pose and colour requirements. The
synchronous JavaScript remains the default (`typescript`); `auto` also keeps
it. The worker compares the first native output byte for byte with the
complete JavaScript reference before accepting it. A missing module, a
compilation or startup failure, a parity mismatch or an operation failure
leaves the complete JavaScript worker path with an explicit reason. There is
one preparation per worker, with bounded startup, a deadline and unconditional
worker termination; a deadline error stops the job rather than accepting
partial output. `prepared.json.nativeCores` records the requested and actual
backend, parity, fallback, jobs, work, startup and preparation time, copy,
live and memory counts, and source receipts. Check `actual: "wasm-single"` and
`parity: "same"` before counting a native measurement. Photographs opened
directly in the browser and panorama scenes have no CPU reprojection job, so
they never use this core.

## ABI and ownership

ABI version 1 exports `projections_abi_version`, `projections_alloc_f32`,
`projections_free_f32`, `projections_alloc_f64`, `projections_free_f64`,
`projections_render_region`, `projections_sample_equirect`, `projections_map`
and unshared `memory`. The additive `projections_window_bounds` and
`projections_render_window` exports plan and render rectangular blocks using
global source coordinates and wrapped contiguous source windows. Typed
allocation and free lengths count **elements**, never bytes. Status 0 means
success; 1 dimensions, 2 lengths, 3 missing or invalid owned allocation,
4 options. Allocation returns 0 on failure. The Rust registry matches pointer,
exact element count and type before reading or writing, and rejects aliased
source and output handles. Arbitrary pointers are never converted into slices.
Reentrant registry access fails without panicking.

The wrapper copies input into owned buffers, refreshes views after memory
growth, copies results out, and frees every allocated buffer in `finally`, also
on traps and status failures. Cleanup failures stay visible. No WASM-backed
view escapes a call. The ABI is single-threaded and has no shared memory.

Bounds are 64 live buffers, 128 MiB per buffer and total live payload, linked
linear memory at most 256 MiB, source sides at most 16384, face sides and
stored region sides at most 4096, 1–8 samples per axis, and at most 2^28 sample
evaluations per region. Bulk preparation uploads only the exact source window
covering every bilinear tap of a bounded output block, copied directly into
WASM; a window crossing longitude zero is copied as two row segments. Output
blocks keep their global pixel and sample coordinates. A 64 MiB target splits
output blocks adaptively under the strict 128 MiB live limit, and one
unsplittable pixel over the hard limit fails explicitly. The full source and
pyramid stay in the owning JavaScript worker, so total process memory is not
limited to 256 MiB. A 4096² full-face output exceeds the output limit.
Per-sample and batch sampling and `renderEquirectRegionWhole` keep the bounded
whole-source ABI, so the 384 MiB source path applies to bulk face and tile
preparation. There is no partial-output or automatic JavaScript fallback
contract on native failure.

## Build and checks

From the sphere-image root:

```sh
npm run build:wasm     # offline; writes single/projections.wasm and build-metadata.json
npm run check:wasm     # source and binary receipts, size and Node validation
npm run check:parity   # scripts/check-projections.mjs --large against the built sphere libraries
npm run test:wasm      # tests/projections-window.test.mjs: ownership and cleanup
```

`check:parity` compares the actual binary with the built `dist/` of
sphere-equirectangular, sphere-cubemap and sphere-tiled-cubemap, so build those
first when their sources changed. It covers all six faces, both warps,
supersampling grids 1–3, gutters, odd source dimensions, seams, poles, edge and
centre tiles and adaptive window splitting, and writes
`build/projections-WASM/projections-parity.json` with the receipts of every
input. On 19 October 2026 it passed 378 cases and 2,683,584 Float32 values with
a full 402,653,184-byte source; peak live ABI buffers were 60,500,448 bytes and
linear memory 95,551,488 bytes. This is correctness and memory evidence. Its
timings are not a paired performance comparison: in that run the WASM regions
took 248 ms against 128 ms for JavaScript, because window planning and copies
cost more than the kernel saves.
