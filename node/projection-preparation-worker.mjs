/** One preparation owns its source/pyramid in this worker; no image is cloned
 * from the calling realm or sent separately for each face. */
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import { prepareSphere } from "./preparation.mjs";
import { cubePreparationPlan } from "@foss-earth/sphere-equirectangular/preparation";
import { renderCubeTile } from "@foss-earth/sphere-tiled-cubemap/preparation";

const { argv, tier, modulePath, ownerDirectory } = workerData;
const startedAt = performance.now();
const report = { core: "projections", requested: tier, actual: "typescript", placement: "worker",
  scope: "cube faces and tiled/gutter equirectangular reprojection; codecs/pyramid/encoding remain JavaScript",
  state: "ready", parity: "not-run", fallbackReason: null, jobs: 0, workMs: 0, parityMs: 0 };
report.workerSha256 = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
report.hostSha256 = createHash("sha256").update(readFileSync(new URL("./projection-preparation.mjs", import.meta.url))).digest("hex");
let core;
if (tier === "single") {
  let timer;
  try {
    // The optional module is explicit: the preparation package has no native
    // dependency and never silently fetches a core in TypeScript mode.
    if (!modulePath) throw new Error("pass --projection-module pointing to native-projections/index.js");
    const moduleUrl = pathToFileURL(path.resolve(modulePath));
    const binaryUrl = new URL("./single/projections.wasm", moduleUrl);
    const bytes = readFileSync(binaryUrl);
    const loading = import(moduleUrl.href).then(module => module.instantiateProjectionCore(bytes));
    core = await Promise.race([loading, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("projection WASM startup exceeded 5 seconds")), 5000);
    })]);
    report.binarySha256 = createHash("sha256").update(bytes).digest("hex");
    report.wrapperSha256 = createHash("sha256").update(readFileSync(moduleUrl)).digest("hex");
    report.coreSha256 = createHash("sha256").update(readFileSync(new URL("./core.js", moduleUrl))).digest("hex");
  } catch (error) { report.state = "fallback"; report.fallbackReason = String(error.message ?? error); }
  finally { clearTimeout(timer); }
} else if (tier === "threaded") {
  report.state = "fallback"; report.fallbackReason = "threaded projection build is unavailable";
}
const reference = request => renderCubeTile(cubePreparationPlan([request.source], request.faceSize),
  request.face, request.faceSize, request.warp, request.gutter, request.regionSize,
  request.originX / request.regionSize, request.originY / request.regionSize);
const kernel = {
  renderEquirectRegion(request) {
    report.jobs++;
    const start = performance.now();
    if (!core) {
      const output = reference(request);
      report.workMs += performance.now() - start;
      return output;
    }
    try {
      const output = core.renderEquirectRegion(request);
      report.workMs += performance.now() - start;
      if (report.parity === "not-run") {
        const parityStart = performance.now();
        const expected = reference(request);
        const a = new Uint8Array(output.data.buffer, output.data.byteOffset, output.data.byteLength);
        const b = new Uint8Array(expected.data.buffer, expected.data.byteOffset, expected.data.byteLength);
        if (output.width !== expected.width || output.height !== expected.height || a.length !== b.length || a.some((v, i) => v !== b[i])) {
          report.parity = "different";
          throw new Error("first projection output differs from the complete TypeScript reference");
        }
        report.parityMs = performance.now() - parityStart;
        report.parity = "same";
      }
      report.actual = "wasm-single";
      return output;
    } catch (error) {
      report.state = "fallback"; report.actual = "typescript";
      report.fallbackReason = String(error.message ?? error);
      core = null;
      // The fallback stays on this complete preparation worker and keeps the
      // original source. Subsequent jobs use the complete TypeScript path.
      return reference(request);
    }
  },
};

report.startupMs = performance.now() - startedAt;
parentPort.postMessage({ type: "ready" });
try {
  const result = prepareSphere(argv, {
    ownerDirectory,
    projectionKernel: kernel,
    projectionReport: () => ({
      ...report,
      preparationMs: performance.now() - startedAt,
      ...(core ? { ...core.preparationStats(), jobs: report.jobs } : {}),
      ...(core && report.jobs === 0 ? { state: "fallback", fallbackReason: "Preparation consumers did not invoke the selected kernel; rebuild sphere-cubemap and sphere-tiled-cubemap" } : {}),
    }),
    log: text => parentPort.postMessage({ type: "log", text }),
  });
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({ type: "error", message: error.message ?? String(error), stack: error.stack });
}
