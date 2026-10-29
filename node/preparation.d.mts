import type { ImageAsset } from "@foss-earth/images";
import type { CubePreparationKernel } from "@foss-earth/sphere-cubemap/preparation";
export interface PreparationPorts { ownerDirectory?: string; log?(text: string): void; projectionKernel?: CubePreparationKernel; projectionReport?(): Record<string, unknown> }
export interface PreparedSphere { exitCode: number; out?: string; help?: string; fragment?: { asset: ImageAsset; imagePose: {headingDeg:number;pitchDeg:number;rollDeg:number} }; provenance?: Record<string, unknown> }
/** Local files only; default scratch belongs to the supplied owner directory. */
export function prepareSphere(argv: readonly string[], ports?: PreparationPorts): PreparedSphere;

/** Equal-work Node worker preparation; --wasm-tier selects the projection kernel. */
export function prepareSphereAsync(argv: readonly string[], ports?: PreparationPorts): Promise<PreparedSphere>;
