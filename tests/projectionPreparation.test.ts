import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prepareSphere, prepareSphereAsync } from "../node/preparation.mjs";

describe("preparation projection worker", () => {
  it("matches the JS output with projections-WASM and explicitly reports an unavailable WASM fallback", async () => {
    const parent = path.resolve("build/checks/projection-worker");
    mkdirSync(parent, { recursive: true });
    const owner = mkdtempSync(path.join(parent, "case-"));
    const pose = path.join(owner, "pose.json");
    writeFileSync(pose, JSON.stringify({ headingDeg: 0, pitchDeg: 0, rollDeg: 0, provenance: "deterministic fixture" }));
    const argv = ["--input", "synthetic:cardinal:64", "--pose", pose, "--attribution", "fixture", "--preview-face-sizes", "8,16", "--tiles", "eac,cube", "--tile-size", "8", "--tile-face-size", "16", "--encoding", "png"];
    const original = prepareSphere([...argv, "--out", path.join(owner, "original")], { log() {} });
    const worker = await prepareSphereAsync([...argv, "--wasm-tier", "typescript-worker", "--out", path.join(owner, "worker")], { log() {} });
    const single = await prepareSphereAsync([...argv, "--wasm-tier", "single", "--out", path.join(owner, "single")], { log() {} });
    const fallback = await prepareSphereAsync([...argv, "--wasm-tier", "single", "--projection-module", path.join(owner, "missing", "index.js"), "--out", path.join(owner, "fallback")], { log() {} });
    for (const result of [worker, single, fallback]) {
      expect(result.fragment).toEqual(original.fragment);
      expect(result.provenance?.outputs).toEqual(original.provenance?.outputs);
      expect(result.provenance?.tiles).toEqual(original.provenance?.tiles);
    }
    expect(worker.provenance?.wasmCores).toMatchObject([{ actual: "typescript", placement: "worker", jobs: 72 }]);
    expect(single.provenance?.wasmCores).toMatchObject([{ requested: "single", actual: "wasm-single", parity: "same", jobs: 72 }]);
    expect(fallback.provenance?.wasmCores).toMatchObject([{ requested: "single", actual: "typescript", state: "fallback", fallbackReason: expect.stringContaining("no such file") }]);
  });
});
