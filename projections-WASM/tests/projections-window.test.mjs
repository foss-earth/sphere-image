import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProjectionCore } from "../core.js";
const bytes = readFileSync(new URL("../single/projections.wasm", import.meta.url));
const math = Object.fromEntries(["atan2", "asin", "atan", "tan", "sin", "cos", "sqrt"].map(name => [name, Math[name]]));
const request = () => ({ source: { width: 64, height: 32, data: Float32Array.from({ length: 64 * 32 * 3 }, (_, i) => i / 1000) },
  face: "ny", faceSize: 8, samplesPerAxis: 3, warp: "equi-angular", gutter: 2, originX: 0, originY: 0, regionSize: 8 });
async function exportsForTest() { return (await WebAssembly.instantiate(bytes, { math })).instance.exports; }
test("windowed reprojection owns returned buffers and preserves the source", async () => {
  const core = createProjectionCore(await exportsForTest());
  const input = request(), saved = input.source.data.slice();
  const output = core.renderEquirectRegion(input);
  const expected = core.renderEquirectRegionWhole(input);
  assert.deepEqual(output.data, expected.data);
  core.renderEquirectRegion({ ...input, face: "pz" });
  assert.deepEqual(output.data, expected.data);
  assert.deepEqual(input.source.data, saved);
});
test("failed window execution releases every buffer and preserves cleanup errors", async () => {
  const raw = await exportsForTest();
  let allocations = 0, frees = 0;
  const exports = { ...raw, projections_render_window() { return 2; } };
  for (const kind of ["f32", "f64"]) {
    exports[`projections_alloc_${kind}`] = length => { allocations++; return raw[`projections_alloc_${kind}`](length); };
    exports[`projections_free_${kind}`] = (pointer, length) => { frees++; return raw[`projections_free_${kind}`](pointer, length); };
  }
  const core = createProjectionCore(exports);
  assert.throws(() => core.renderEquirectRegion(request()), /buffer lengths/);
  assert.equal(allocations, frees);
  exports.projections_free_f32 = () => 3;
  assert.throws(() => createProjectionCore(exports).renderEquirectRegion(request()), AggregateError);
});
test("raw window ABI rejects unowned and incomplete window buffers without trapping", async () => {
  const raw = await exportsForTest();
  const output = raw.projections_alloc_f32(3);
  assert.equal(raw.projections_render_window(1234, 3, 64, 32, 0, 0, 1, 1, 0, 8, 2, 0, 0, 0, 0, 8, 0, 0, 1, 1, output, 3), 3);
  const source = raw.projections_alloc_f32(3);
  assert.equal(raw.projections_render_window(source, 3, 64, 32, 0, 0, 1, 1, 0, 8, 2, 0, 0, 0, 0, 8, 0, 0, 1, 1, output, 3), 2);
  assert.equal(raw.projections_free_f32(source, 3), 0);
  assert.equal(raw.projections_free_f32(output, 3), 0);
});
