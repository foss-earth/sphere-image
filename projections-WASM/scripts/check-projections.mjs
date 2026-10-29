/** Actual WASM versus public JS; --large retains a full 384 MiB source. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { instantiateProjectionCore } from "../index.js";
import { cubePreparationPlan, renderCubeFace, renderCubeTile } from "../../projections-TS/index.js";
const root = new URL("../", import.meta.url);
const binary = new URL("single/projections.wasm", root);
const core = await instantiateProjectionCore(readFileSync(binary));
const faces = ["px", "nx", "py", "ny", "pz", "nz"];
let cases = 0, values = 0, wasmMs = 0, referenceMs = 0;
function check(request, expected) {
  let start = performance.now();
  const actual = core.renderEquirectRegion(request);
  wasmMs += performance.now() - start;
  start = performance.now();
  const reference = expected();
  referenceMs += performance.now() - start;
  assert.equal(actual.width, reference.width); assert.equal(actual.height, reference.height);
  assert.deepEqual(Buffer.from(actual.data.buffer), Buffer.from(reference.data.buffer), JSON.stringify({ ...request, source: [request.source.width, request.source.height] }));
  cases++; values += actual.data.length;
}
function source(width, height) {
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = ((i * 17 + Math.floor(i / width) * 13) % 4093) / 4093;
  return { width, height, data };
}
for (const [width, height] of [[2, 1], [128, 64], [257, 129]]) {
  const image = source(width, height);
  for (const face of faces) for (const samples of [1, 2, 3]) {
    const plan = { ...cubePreparationPlan([image], 16), samplesPerAxis: samples };
    const request = { source: image, face, faceSize: 16, samplesPerAxis: samples, warp: "gnomonic", gutter: 0, originX: 0, originY: 0, regionSize: 16 };
    check(request, () => renderCubeFace(plan, face, 16));
    check(request, () => core.renderEquirectRegionWhole(request));
    for (const warp of ["gnomonic", "equi-angular"]) for (const [x, y] of [[0, 0], [1, 1]]) {
      check({ ...request, warp, gutter: 2, originX: x * 8, originY: y * 8, regionSize: 8 },
        () => renderCubeTile(plan, face, 16, warp, 2, 8, x, y));
    }
  }
}
let largeSourceBytes = 0;
if (process.argv.includes("--large")) {
  const image = source(8192, 4096);
  largeSourceBytes = image.data.byteLength;
  const faceSize = 2048, tileSize = 128;
  const plan = cubePreparationPlan([image], faceSize);
  for (const face of faces) for (const warp of ["gnomonic", "equi-angular"]) for (const [x, y] of [[0, 0], [7, 7], [8, 8], [15, 15]]) {
    check({ source: image, face, faceSize, samplesPerAxis: plan.samplesPerAxis, warp, gutter: 1, originX: x * tileSize, originY: y * tileSize, regionSize: tileSize },
      () => renderCubeTile(plan, face, faceSize, warp, 1, tileSize, x, y));
  }
  const coarse = cubePreparationPlan([image], 64);
  for (const face of faces) check({ source: image, face, faceSize: 64, samplesPerAxis: coarse.samplesPerAxis, warp: "gnomonic", gutter: 0, originX: 0, originY: 0, regionSize: 64 },
    () => renderCubeFace(coarse, face, 64));
}
const stats = core.preparationStats();
assert.ok(stats.peakLiveBytes <= 128 * 1024 * 1024);
assert.ok(stats.memoryBytes <= 256 * 1024 * 1024);
// The reference is the built preparation module of each sphere library.
const references = ["sphere-cubemap", "sphere-tiled-cubemap", "sphere-equirectangular"].map(name => new URL(import.meta.resolve(`@foss-earth/${name}/preparation`)));
const inputs = [binary, new URL("core.js", root), new URL("index.js", root), new URL("crates/earth-projections/src/lib.rs", root), ...references];
const report = { parity: "same", cases, values, largeSourceBytes, wasmMs, referenceMs, ...stats,
  receipts: Object.fromEntries(inputs.map(url => [fileURLToPath(url), createHash("sha256").update(readFileSync(url)).digest("hex")])) };
// Reports go under the owning repository's ignored build/.
const reports = new URL("../build/projections-WASM/", root);
mkdirSync(reports, { recursive: true });
writeFileSync(new URL("projections-parity.json", reports), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
