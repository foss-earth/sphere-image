import { createProjectionCore, requireProjectionWorker } from "./core.js";

let loading;

/** Lazy, worker-compatible loading. Importing the package performs no I/O. */
export function loadProjectionCore() {
  requireProjectionWorker();
  loading ??= (async () => {
    const response = await fetch(new URL("./single/projections.wasm", import.meta.url));
    if (!response.ok) throw new Error(`Projection WASM fetch failed (${response.status})`);
    return instantiateProjectionCore(await response.arrayBuffer());
  })();
  return loading;
}

export async function instantiateProjectionCore(bytes) {
  requireProjectionWorker();
  let view;
  if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
  else if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  else throw new TypeError("Projection WASM bytes must be an ArrayBuffer or view");
  // Use this executing JS realm's functions, rather than a Rust libm, and own
  // the binary before asynchronous compilation can observe caller mutations.
  const math = { atan2: Math.atan2, asin: Math.asin, atan: Math.atan, tan: Math.tan,
    sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt };
  const { instance } = await WebAssembly.instantiate(new Uint8Array(view), { math });
  return createProjectionCore(instance.exports);
}
