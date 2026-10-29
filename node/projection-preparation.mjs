import { Worker } from "node:worker_threads";
import { prepareSphere } from "./preparation.mjs";

function option(argv, name) {
  const index = argv.findIndex(value => value === `--${name}` || value.startsWith(`--${name}=`));
  return index < 0 ? undefined : argv[index].includes("=") ? argv[index].slice(name.length + 3) : argv[index + 1];
}
/** Actual CLI preparation in one owning worker. The complete original sync
 * implementation stays available as `prepareSphere` and tier `typescript`. */
export async function prepareSphereAsync(argv, ports = {}) {
  const tier = option(argv, "wasm-tier") ?? "typescript";
  if (!["typescript", "typescript-worker", "single", "auto", "threaded"].includes(tier)) throw new Error("--wasm-tier is typescript, typescript-worker, single, auto or threaded");
  if (tier === "typescript" || tier === "auto") return prepareSphere(argv, ports);
  const worker = new Worker(new URL("./projection-preparation-worker.mjs", import.meta.url), {
    workerData: { argv, tier, modulePath: option(argv, "projection-module"), ownerDirectory: ports.ownerDirectory },
  });
  let startup, deadline;
  try {
    return await new Promise((resolve, reject) => {
      startup = setTimeout(() => reject(new Error("projection preparation worker startup exceeded 15 seconds")), 15000);
      // One source, one bounded queue (one preparation). Termination interrupts
      // synchronous WASM too; a Promise timeout inside the worker cannot.
      deadline = setTimeout(() => reject(new Error("projection preparation exceeded 15 minutes")), 15 * 60 * 1000);
      worker.on("message", message => {
        if (message.type === "ready") clearTimeout(startup);
        else if (message.type === "log") (ports.log ?? console.log)(message.text);
        else if (message.type === "result") resolve(message.result);
        else if (message.type === "error") reject(new Error(message.message));
      });
      worker.on("error", reject);
      worker.on("exit", code => reject(new Error(`projection preparation worker exited (${code}) before completion`)));
    });
  } finally {
    clearTimeout(startup); clearTimeout(deadline);
    await worker.terminate();
  }
}
