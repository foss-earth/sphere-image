export type CubeFaceName = "px" | "nx" | "py" | "ny" | "pz" | "nz";
export type CubeWarp = "gnomonic" | "equi-angular";
export interface LinearImage { width: number; height: number; data: Float32Array; }
export type ColourOutput = Float32Array | Float64Array | number[];
export interface CubeRegionRequest {
  source: LinearImage;
  face: CubeFaceName;
  faceSize: number;
  samplesPerAxis: number;
  warp: CubeWarp;
  gutter: number;
  originX: number;
  originY: number;
  regionSize: number;
}
export interface ProjectionCore {
  readonly actualTier: "single";
  readonly validationStatus: "unvalidated";
  renderEquirectRegion(request: CubeRegionRequest): LinearImage;
  /** Retained bounded whole-source implementation, for parity checks. */
  renderEquirectRegionWhole(request: CubeRegionRequest): LinearImage;
  preparationStats(): { jobs: number; blocks: number; copiedBytes: number; peakLiveBytes: number; memoryBytes: number };
  /** Interleaved uv input -> interleaved RGB f64 output. */
  sampleEquirectBatch(level: LinearImage, uv: Float64Array): Float64Array;
  /** Interleaved xyz input -> interleaved RGB f64 output. */
  sampleDirectionBatch(level: LinearImage, xyz: Float64Array): Float64Array;
  sampleEquirect(level: LinearImage, u: number, v: number, out: ColourOutput): void;
  sampleDirection(level: LinearImage, x: number, y: number, z: number, out: ColourOutput): void;
  /** Preparation's arithmetic hypot normalization, not core sqrt normalization. */
  equirectUvBatch(xyz: Float64Array): Float64Array;
  equirectDirectionBatch(uv: Float64Array): Float64Array;
  equirectCoordinatesBatch(xyz: Float64Array): Float64Array;
  sourceCubeDirectionBatch(face: CubeFaceName, uv: Float64Array): Float64Array;
  /** Interleaved [faceIndex,u,v]; face indices follow px,nx,py,ny,pz,nz. */
  sourceCubeLookupBatch(xyz: Float64Array): Float64Array;
  cubeTilingDirectionBatch(face: CubeFaceName, uv: Float64Array, warp: CubeWarp): Float64Array;
  /** Interleaved [faceIndex,u,v]; preserves cubeTiling's major-axis tie rules. */
  cubeTilingLocateBatch(xyz: Float64Array, warp: CubeWarp): Float64Array;
}
/** No fetching or compilation occurs until called. Reuses one single-threaded instance. */
export function loadProjectionCore(): Promise<ProjectionCore>;
/** Creates an independent instance; useful in a worker with bytes supplied by its owner. */
export function instantiateProjectionCore(bytes: ArrayBuffer | ArrayBufferView): Promise<ProjectionCore>;
