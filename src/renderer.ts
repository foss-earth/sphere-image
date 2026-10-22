/**
 * Draws sphere orbs over the globe and the immersive view
 * (docs/proposals/panorama-scenes.md §3): each orb is a quad whose
 * fragments cast the camera's own rays at a ball, with depth where the ray
 * meets it, so terrain in front hides it; immersion is one triangle covering
 * the view. Every frame's uniforms are computed from the camera as it is for
 * that frame, in float64 on the CPU, immediately before the mesh draws.
 *
 * WebGPU and WebGL use the same geometry and analytic depth. WebGL 1 needs
 * fragment depth and standard derivatives to preserve that contract.
 */
import {
  Color4,
  Constants,
  Matrix,
  Mesh,
  RawTexture,
  RenderTargetTexture,
  ShaderLanguage,
  ShaderMaterial,
  Vector4,
  VertexData,
  type BaseTexture,
  type Camera,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import {
  add,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  type Mat3,
  type Vec3,
} from "@foss-earth/images";
import type { ViewBasis } from "./math.js";
interface ViewerProfiler { clock(): number; add(section: string, startedAt: number): void }
import type { ViewerNavigationPresentation as NavigationPresentation } from "./ports.js";
import {
  IMMERSION_FRAGMENT,
  IMMERSION_UNIFORMS,
  IMMERSION_VERTEX,
  NEXT_TILE_SAMPLERS,
  ORB_FRAGMENT,
  ORB_UNIFORMS,
  ORB_VERTEX,
  TILE_SAMPLERS,
} from "./shaders.js";
import { IMMERSION_FRAGMENT_GLSL, IMMERSION_LEAN_UNIFORMS, IMMERSION_VERTEX_GLSL, ORB_FRAGMENT_GLSL, ORB_LEAN_UNIFORMS, ORB_VERTEX_GLSL } from "./shadersWebGl.js";
import { isBorrowedWebGpuEngine } from "@foss-earth/renderer/babylon";

/** One frame's camera, as the globe is drawn with it: eye in float64 ECEF and the rotation-and-projection matrix. */
export interface SphereCameraFrame {
  eye: Vec3;
  viewRotProj: Matrix;
  inverseViewRotProj: Matrix;
  view: ViewBasis;
  viewportHeightCssPx: number;
  /** A digest of the camera state, to correlate a frame's draws with its camera. */
  readonly revision: string;
}

export interface OrbAppearance {
  /** Full angle of the flat window, degrees: `scene.panorama.previewFov`. */
  previewFovDeg: number;
  /** Effective radius bounds as projected diameters, CSS px: `scene.panorama.markerDiameter`. */
  markerDiameterCssPx: { min: number; max: number };
  /** Pointer tolerance, CSS px: `scene.panorama.hitTargetDiameter`. */
  hitTargetDiameterCssPx: number;
}

export interface OrbState {
  /** Marker centre in ECEF, float64; null while its placement is pending. */
  marker: Vec3 | null;
  /** Authored or fallback radius, metres, before screen-size bounds. */
  radiusMeters: number;
  /** ECEF → image-local rotation. */
  content: Mat3;
  texture: BaseTexture | null;
  visible: boolean;
  /** A ring just outside the silhouette: sRGB and alpha 0–1, width in CSS px; null draws none. */
  outline: { color: readonly [number, number, number, number]; widthPx: number } | null;
  /** Multiplies the radius after the screen-size bounds, as a hover grows the orb: 1 normally. */
  displayScale: number;
  /** 1 is solid. Lower values draw the photograph over whatever is behind it. */
  opacity?: number;
}

export interface OrbExpansion {
  /** The virtual radius the orb and its overlay draw with, metres. */
  radiusMeters: number;
  /** 0: clipped by terrain like the orb; 1: drawn over everything. */
  reveal: number;
  /** The image the overlay draws instead of the orb's preview, as a flight out of the sphere on screen starts from it. */
  source?: ImmersionSource | null;
}

export interface SphereOrb {
  readonly id: string;
  update(state: Partial<OrbState>): void;
  /** Draws the orb as a ball of the expansion's radius, with its overlay over everything, or stops with null. */
  setExpansion(expansion: OrbExpansion | null): void;
  /** The radius used this frame for silhouette, depth and picking. */
  effectiveRadius(frame?: SphereCameraFrame): number | null;
  dispose(): void;
}

/** A tiled cube's GPU side, as its shaders take it (src/scenes/tiles/). */
export interface TiledSourceTextures {
  atlas: BaseTexture;
  table: BaseTexture;
  /** Cells along a face side, a tile's logical texels, its gutter and its stored side. */
  layout: readonly [number, number, number, number];
  /** The atlas's width and height, texels. */
  atlasSize: readonly [number, number];
  warp: "equi-angular" | "gnomonic";
  /** Draws each tile's edges, tinted by its level; read at every draw. */
  outlines: boolean;
}

export interface ImmersionSource {
  /** The cube or equirectangular image; for a tiled cube, the preview cube that shows where no tile has arrived. */
  texture: BaseTexture;
  kind: "cube" | "equirectangular" | "tiles";
  content: Mat3;
  /** For kind "tiles". */
  tiles?: TiledSourceTextures;
}

export interface SphereImmersion {
  /**
   * Draws `source` full screen; `next` blends in by `mix` for a crossfade.
   * `view` draws it with that view while the globe camera's still shows
   * behind it, as in a fade; without it the lease's presentation or the
   * globe camera's view is used. Null hides it.
   */
  show(state: { source: ImmersionSource; next?: ImmersionSource | null; mix?: number; opacity?: number; view?: NavigationPresentation | null } | null): void;
  /** Multiplies the opacity `show` asked for. 1 leaves that fade unchanged. */
  setOpacity(opacity: number): void;
  /** Keeps the image on screen and samples it with a new orientation. */
  replaceContent(content: Mat3): void;
  readonly visible: boolean;
}

export interface OrbHit {
  id: string;
  /** Metres from the eye to the orb's near surface. */
  depthMeters: number;
  /** Whether the ray met the silhouette itself or only the enlarged pointer target. */
  onSilhouette: boolean;
}

export type SphereProbeOutput = "direction" | "ray";

export interface SphereProbeResult {
  width: number;
  height: number;
  /** Per output asked for, RGBA float32 rows as read back: xyz and coverage. */
  outputs: Partial<Record<SphereProbeOutput, Float32Array>>;
  /** The camera frame every output was drawn with: one frame for all. */
  frame: SphereCameraFrame;
}

/**
 * Changes meant to draw the same picture with less work, off until validated
 * (docs/validation/panorama-experiments.md). Each is a renderer.experiments.* parameter.
 */
export interface SphereRendererExperiments {
  /** Draw records, camera revisions and earlier frames' uniforms only while a check captures or delays. */
  bookkeeping: boolean;
  /** Immersion at full opacity drawn without blending. */
  opaqueImmersion: boolean;
  /** WebGL: the SPHERE_LEAN shaders. WebGPU draws as before. */
  shaders: boolean;
}

export const NO_SPHERE_EXPERIMENTS: Readonly<SphereRendererExperiments> = { bookkeeping: false, opaqueImmersion: false, shaders: false };

export interface SphereRenderer {
  readonly available: boolean;
  /** Why spheres cannot be drawn, or null. */
  readonly unavailableReason: string | null;
  addOrb(id: string, state: OrbState): SphereOrb;
  readonly immersion: SphereImmersion;
  setAppearance(appearance: OrbAppearance): void;
  /** The camera frame the next draw uses: the presentation view when one is set, or `view`. */
  cameraFrame(view?: NavigationPresentation | null): SphereCameraFrame | null;
  /** Orbs under a canvas point (CSS px), nearest first, then by id; occluded ones left out by the caller's test. */
  pick(clientX: number, clientY: number, isOccluded: (eye: Vec3, direction: Vec3, distance: number) => boolean): OrbHit[];
  /** Orbs along a world ray, such as a headset controller's, ordered as `pick` orders them. */
  pickRay(origin: Vec3, direction: Vec3, isOccluded: (eye: Vec3, direction: Vec3, distance: number) => boolean): OrbHit[];
  /** Where a world direction from the eye lands on the canvas, CSS px, or null behind the view. */
  project(direction: Vec3, frame?: SphereCameraFrame): { x: number; y: number } | null;
  /** Whether `project` would place the direction on the canvas, without reading the page's layout. */
  onScreen(direction: Vec3, frame?: SphereCameraFrame): boolean;
  /**
   * Test only: renders what `target` shows as float vectors and reads them
   * back, each output in its own render target within one rendered frame:
   * the view ray each pixel drew with, and the image direction it sampled.
   */
  probe(target: { orb: string } | { immersion: true }, outputs: readonly SphereProbeOutput[]): Promise<SphereProbeResult>;
  /** Turns the work-saving experiments on or off; what is left out keeps its value. */
  setExperiments(experiments: Partial<SphereRendererExperiments>): void;
  /** Test only: draw with uniforms this many frames old (the negative control). */
  setUniformDelayFrames(frames: number): void;
  /**
   * Test only: keeps draw records even when the bookkeeping experiment leaves
   * them out. Without that experiment they are always kept.
   */
  captureDraws(capture: boolean): void;
  /** Test only: the last frames' camera and uniform revisions, to show no draw used a stale camera. */
  drawRecords(): readonly { frameId: number; target: string; cameraRevision: string; uniformRevision: string }[];
  /** Test only: what an orb draws from, and its radius in `frame`, for a CPU reference to use the same inputs. */
  inspectOrb(id: string, frame?: SphereCameraFrame): { marker: Vec3 | null; radiusMeters: number; effectiveRadius: number | null; content: Mat3; visible: boolean; textured: boolean } | null;
  dispose(): void;
}

// ─── Pure geometry ─────────────────────────────────────────────────────

/**
 * The quad an orb draws: perpendicular to the axis, or across the view when
 * the orb is near or around the eye. `marginCssPx` more beyond the
 * silhouette leaves room for an outline.
 */
export function orbQuad(rel: Vec3, radius: number, frame: Pick<SphereCameraFrame, "view" | "viewportHeightCssPx">, nearPlane: number, marginCssPx = 0): { center: Vec3; u: Vec3; v: Vec3; fullscreen: boolean } {
  const d = length(rel);
  const { view } = frame;
  const tanHalf = Math.tan(view.verticalFovRad / 2);
  // Beyond 80° from its centre the cap's quad would be huge; cover the view instead.
  const fullscreen = d <= radius * 1.02 || radius / d > Math.sin((80 * Math.PI) / 180);
  if (fullscreen) {
    const s = Math.max(nearPlane * 1.5, 1e-3);
    return {
      center: scale(view.forward, s),
      u: scale(view.right, s * tanHalf * view.aspect * 1.05),
      v: scale(view.up, s * tanHalf * 1.05),
      fullscreen,
    };
  }
  const a = scale(rel, 1 / d);
  const alpha = Math.asin(radius / d);
  // Three pixels beyond the silhouette leave room for its antialiased edge.
  const pixel = (d * 2 * tanHalf) / Math.max(1, frame.viewportHeightCssPx);
  const half = d * Math.tan(alpha) + (3 + marginCssPx) * pixel;
  const helper = Math.abs(dot(a, view.up)) < 0.9 ? view.up : view.right;
  const u = normalize(cross(a, helper));
  const v = cross(u, a);
  return { center: rel, u: scale(u, half), v: scale(v, half), fullscreen };
}

/** Reject only a quad wholly outside a side clip plane or behind the eye. */
export function orbQuadOutsideView(quad: ReturnType<typeof orbQuad>, matrix: Matrix): boolean {
  if (quad.fullscreen) return false;
  const { center: c, u, v } = quad, m = matrix.m;
  const x = c[0] * m[0] + c[1] * m[4] + c[2] * m[8] + m[12];
  const y = c[0] * m[1] + c[1] * m[5] + c[2] * m[9] + m[13];
  const w = c[0] * m[3] + c[1] * m[7] + c[2] * m[11] + m[15];
  const ux = u[0] * m[0] + u[1] * m[4] + u[2] * m[8], vx = v[0] * m[0] + v[1] * m[4] + v[2] * m[8];
  const uy = u[0] * m[1] + u[1] * m[5] + u[2] * m[9], vy = v[0] * m[1] + v[1] * m[5] + v[2] * m[9];
  const uw = u[0] * m[3] + u[1] * m[7] + u[2] * m[11], vw = v[0] * m[3] + v[1] * m[7] + v[2] * m[11];
  // Bound rounding of the shader's float32 inputs, corner sums and matrix
  // products by their magnitudes before cancellation, including translation.
  // Keep ambiguous, nonfinite and boundary quads. No near/far-plane convention
  // is assumed, so this works for both WebGL and WebGPU projections.
  const slack = 1e-4 * (
    (Math.abs(c[0]) + Math.abs(u[0]) + Math.abs(v[0])) * (Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[3])) +
    (Math.abs(c[1]) + Math.abs(u[1]) + Math.abs(v[1])) * (Math.abs(m[4]) + Math.abs(m[5]) + Math.abs(m[7])) +
    (Math.abs(c[2]) + Math.abs(u[2]) + Math.abs(v[2])) * (Math.abs(m[8]) + Math.abs(m[9]) + Math.abs(m[11])) +
    Math.abs(m[12]) + Math.abs(m[13]) + Math.abs(m[15]));
  return x - w - Math.abs(ux - uw) - Math.abs(vx - vw) > slack ||
    -x - w - Math.abs(ux + uw) - Math.abs(vx + vw) > slack ||
    y - w - Math.abs(uy - uw) - Math.abs(vy - vw) > slack ||
    -y - w - Math.abs(uy + uw) - Math.abs(vy + vw) > slack ||
    -w - Math.abs(uw) - Math.abs(vw) > slack;
}

/** The radius that keeps an orb's projected diameter within the marker bounds, metres. */
export function effectiveOrbRadius(radiusMeters: number, distance: number, frame: Pick<SphereCameraFrame, "view" | "viewportHeightCssPx">, bounds: { min: number; max: number }): number {
  const tanHalf = Math.tan(frame.view.verticalFovRad / 2);
  const metresPerPixel = (distance * 2 * tanHalf) / Math.max(1, frame.viewportHeightCssPx);
  const low = (bounds.min / 2) * metresPerPixel;
  const high = (bounds.max / 2) * metresPerPixel;
  return Math.min(Math.max(radiusMeters, low), Math.max(low, high));
}

function basisFromViewMatrix(view: Matrix): { forward: Vec3; right: Vec3; up: Vec3 } {
  const m = view.m;
  return {
    right: normalize([m[0], m[4], m[8]]),
    up: normalize([m[1], m[5], m[9]]),
    forward: normalize([-m[2], -m[6], -m[10]]),
  };
}

function rotationOnly(view: Matrix): Matrix {
  const m = view.m;
  return Matrix.FromValues(m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1);
}

/** The right-handed view rotation of a presentation's forward and up. */
function presentationRotation(presentation: NavigationPresentation): { matrix: Matrix; basis: { forward: Vec3; right: Vec3; up: Vec3 } } {
  const forward = normalize([presentation.forward.x, presentation.forward.y, presentation.forward.z]);
  const right = normalize(cross(forward, [presentation.up.x, presentation.up.y, presentation.up.z]));
  const up = cross(right, forward);
  const matrix = Matrix.FromValues(
    right[0], up[0], -forward[0], 0,
    right[1], up[1], -forward[1], 0,
    right[2], up[2], -forward[2], 0,
    0, 0, 0, 1,
  );
  return { matrix, basis: { forward, right, up } };
}

const toVector = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
/** Babylon's own default near plane, used only if the scene has no camera. */
const NEAR_PLANE_WITHOUT_CAMERA = 0.1;

// ─── Renderer ──────────────────────────────────────────────────────────

export interface SphereRendererOptions {
  getCamera(): Camera | null;
  viewportHeightCssPx(): number;
  presentationLayerMask: number;
  appearance: OrbAppearance;
  /** The lease's presented view, read at draw time. */
  getPresentationView(): NavigationPresentation | null;
  /**
   * Whether each eye's own view and projection are drawn, as in an immersive
   * headset session: presented views, and the views of fades, are then left out.
   */
  isHeadTracked?(): boolean;
  requestRender(): void;
  /** A shader rejected by the device, once per distinct diagnostic, for the host's log. */
  onError?: (message: string) => void;
  /** Where preparing each draw's direction and parameters is timed, inside the draw phase. */
  profiler?: ViewerProfiler;
  /** The experiments to start with; all off when omitted. */
  experiments?: Partial<SphereRendererExperiments>;
}

/** The lean shaders' marker: the variant is chosen per material by this define. */
const LEAN_DEFINE = "#define SPHERE_LEAN";

/** A digest of a camera frame's inputs, to correlate a draw with its camera. */
function frameRevision(eye: Vec3, basis: { forward: Vec3; up: Vec3 }, verticalFovRad: number, aspect: number): string {
  return [...eye, ...basis.forward, ...basis.up, verticalFovRad, aspect].map(value => value.toPrecision(12)).join(",");
}

/**
 * An orb's per-draw constants, in float64, as the lean orb shader takes
 * them: its cap angle and flat window, which its fragments would otherwise
 * each work out from the marker, the radius and the preview's angle. The
 * distance and depth stay per fragment, in the shader's own arithmetic.
 */
export function orbDrawConstants(rel: Vec3, radius: number, tanPreviewHalfAngle: number): { sinAlpha: number; windowGain: number; identityWindow: boolean } {
  const distance = length(rel);
  const sinAlpha = Math.min(radius / distance, 1);
  const cosAlpha = Math.sqrt(Math.max(1 - sinAlpha * sinAlpha, 0));
  const tanAlpha = sinAlpha / Math.max(cosAlpha, 1e-7);
  return {
    sinAlpha,
    windowGain: tanPreviewHalfAngle / Math.max(tanAlpha, 1e-7),
    identityWindow: distance <= radius || tanAlpha >= tanPreviewHalfAngle,
  };
}

/**
 * The lean immersion's matrix from clip space to a ray in an image's frame:
 * the inverse view-and-projection, then the image's rotation, divided by the
 * ray's w. w is the same at every corner of the view (clip z and w are, and
 * a perspective's w does not depend on x or y), so the division is exact
 * across the triangle and the vertex shader needs none.
 */
export function imageFromClipMatrix(inverseViewRotProj: Matrix, content: Mat3, result: Matrix): Matrix {
  const m = inverseViewRotProj.m;
  // The ray's w at clip (0, 0, 0.5, 1); Babylon's row vectors: v' = v · M.
  const w = 0.5 * m[11] + m[15];
  const values: number[] = new Array(16);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 3; column++) {
      const image = content[column];
      values[row * 4 + column] = (m[row * 4] * image[0] + m[row * 4 + 1] * image[1] + m[row * 4 + 2] * image[2]) / w;
    }
    values[row * 4 + 3] = m[row * 4 + 3] / w;
  }
  return Matrix.FromArrayToRef(values, 0, result);
}

/** Nested under profileBabylonScene's draw phase, which these draws run in. */
const UNIFORMS_SECTION = "render/draw/panorama uniforms";
/** How many of the last draws drawRecords returns. */
const RECORDS_KEPT = 600;

export function createSphereRenderer(scene: Scene, options: SphereRendererOptions): SphereRenderer {
  const engine = scene.getEngine();
  const webGpu = isBorrowedWebGpuEngine(engine);
  const caps = engine.getCaps();
  const unavailableReason = webGpu ? null
    : !caps.fragmentDepthSupported ? "This graphics context cannot draw panorama depth. WebGL 1 needs the EXT_frag_depth extension."
      : !caps.standardDerivatives ? "This graphics context cannot draw panorama edges. WebGL 1 needs the OES_standard_derivatives extension."
        : !caps.highPrecisionShaderSupported ? "This graphics context cannot draw panoramas with the required shader precision."
          : null;
  const available = unavailableReason === null;
  const webGl2 = !webGpu && "webGLVersion" in engine && Number(engine.webGLVersion) >= 2;
  const backendDefines = webGpu ? [] : [
    ...(webGl2 ? ["#define SPHERE_WEBGL2"] : []),
    ...(webGl2 || caps.textureLOD ? ["#define SPHERE_TEXTURE_GRADIENTS"] : []),
  ];
  const shaderLanguage = webGpu ? ShaderLanguage.WGSL : ShaderLanguage.GLSL;
  let appearance: OrbAppearance = options.appearance;
  const experiments: SphereRendererExperiments = { ...NO_SPHERE_EXPERIMENTS, ...options.experiments };
  /** The lean shaders exist in GLSL only. */
  const leanShaders = (): boolean => experiments.shaders && !webGpu;
  let captureDraws = false;
  /** Whether draws are recorded and their camera frames kept for the negative control. */
  const keepingRecords = (): boolean => !experiments.bookkeeping || captureDraws;
  let delayFrames = 0;
  /** The last RECORDS_KEPT draws, in order; trimmed in batches, so a draw does not shift the whole list. */
  const records: { frameId: number; target: string; cameraRevision: string; uniformRevision: string }[] = [];
  const orbs = new Map<string, OrbInternal>();
  let disposed = false;
  // The globe may sleep while an asynchronously compiled shader finishes.
  // Its first usable frame must not wait for another camera or map update.
  const onCompiled = (): void => { forgetPassHeight(); if (!disposed) options.requestRender(); };
  const shaderErrors = new Set<string>();
  const onError: NonNullable<ShaderMaterial["onError"]> = (_effect, message) => {
    forgetPassHeight();
    if (disposed || shaderErrors.has(message)) return;
    shaderErrors.add(message);
    options.onError?.(message);
  };
  const profiler = options.profiler;
  /** Times a draw's preparation in the frame budget. */
  const timed = (prepare: () => void) => (): void => {
    const started = profiler?.clock() ?? 0;
    prepare();
    if (started) profiler!.add(UNIFORMS_SECTION, started);
  };

  const canvasCssHeight = (): number => options.viewportHeightCssPx();
  // The height every draw of one camera pass reads, read at the pass's first draw. Between two draws a pass runs
  // only Babylon's draw loop, the terrain's material plugins and these observers, none of which writes the page,
  // and these materials' compile callbacks, which call the host and so forget it. Babylon numbers each camera
  // and render target pass, and the height is read again in each task.
  let passRenderId = -1, passCssHeight = 0;
  function forgetPassHeight(): void { passRenderId = -1; }
  function drawCssHeight(): number {
    const renderId = scene.getRenderId();
    if (renderId !== passRenderId) {
      if (passRenderId === -1) queueMicrotask(forgetPassHeight);
      passRenderId = renderId;
      passCssHeight = canvasCssHeight();
    }
    return passCssHeight;
  }
  const headTracked = (): boolean => options.isHeadTracked?.() === true;
  /** The view that replaces the camera's: none while a head is tracked. */
  const presentationView = (): NavigationPresentation | null => (headTracked() ? null : options.getPresentationView());
  const immersionView = (): NavigationPresentation | null => (headTracked() ? null : immersionState?.view ?? null);

  /** The camera the globe is drawn with this frame, or the presentation that replaces its view. */
  function currentFrame(presentation = presentationView(), height = canvasCssHeight): SphereCameraFrame | null {
    const camera: Camera | null = options.getCamera();
    if (!camera) return null;
    // The eye is updated with the view matrix: bring both up to date before reading either.
    const view = camera.getViewMatrix();
    const position = camera.globalPosition;
    const eye: Vec3 = [position.x, position.y, position.z];
    const aspect = engine.getAspectRatio(camera);
    let rotation: Matrix;
    let projection: Matrix;
    let basis: { forward: Vec3; right: Vec3; up: Vec3 };
    let verticalFovRad: number;
    if (presentation) {
      const presented = presentationRotation(presentation);
      rotation = presented.matrix;
      basis = presented.basis;
      verticalFovRad = presentation.verticalFovRad;
      projection = Matrix.PerspectiveFovRH(verticalFovRad, aspect, 0.1, 1000, engine.isNDCHalfZRange);
    } else {
      rotation = rotationOnly(view);
      basis = basisFromViewMatrix(view);
      verticalFovRad = camera.fov;
      projection = camera.getProjectionMatrix();
    }
    const viewRotProj = rotation.multiply(projection);
    const inverseViewRotProj = viewRotProj.clone().invert();
    const frame = {
      eye,
      viewRotProj,
      inverseViewRotProj,
      view: { ...basis, verticalFovRad, aspect },
      viewportHeightCssPx: height(),
    };
    if (!experiments.bookkeeping) return { ...frame, revision: frameRevision(eye, basis, verticalFovRad, aspect) };
    // Formatted only when something reads it: a check's records, never an ordinary draw.
    let revision: string | null = null;
    return Object.defineProperty(frame, "revision", {
      get: () => (revision ??= frameRevision(eye, basis, verticalFovRad, aspect)),
      enumerable: true,
    }) as SphereCameraFrame;
  }

  /** What the camera frame depends on, cheaply: the camera, its matrices' versions, the aspect and the canvas height. */
  function cameraKey(height: () => number): string {
    const camera = options.getCamera();
    if (!camera) return "";
    return `${camera.uniqueId}:${camera.getViewMatrix().updateFlag}:${camera.getProjectionMatrix().updateFlag}:${engine.getAspectRatio(camera)}:${height()}`;
  }
  /** The same inputs as cameraKey, compared in place without building a string for every draw. */
  const lastCameraInputs = { camera: -1, view: -1, projection: -1, aspect: Number.NaN, height: Number.NaN };
  function cameraInputsChanged(height: () => number): boolean {
    const camera = options.getCamera();
    const id = camera?.uniqueId ?? -1;
    const view = camera ? camera.getViewMatrix().updateFlag : -1;
    const projection = camera ? camera.getProjectionMatrix().updateFlag : -1;
    const aspect = camera ? engine.getAspectRatio(camera) : 0;
    const cssHeight = camera ? height() : 0;
    const last = lastCameraInputs;
    const changed = last.camera !== id || last.view !== view || last.projection !== projection || last.aspect !== aspect || last.height !== cssHeight;
    last.camera = id;
    last.view = view;
    last.projection = projection;
    last.aspect = aspect;
    last.height = cssHeight;
    return changed;
  }

  // The frame every draw uses, and, for the negative control, one per earlier
  // rendered frame. It is computed again whenever the camera or the presented
  // view changed since, even within one rendered frame, so a draw never uses a
  // camera from before a move.
  let frameCache: { id: number; key: string; presentation: NavigationPresentation | null; frame: SphereCameraFrame | null } | null = null;
  const history: SphereCameraFrame[] = [];
  let historyFrameId = -1;
  /** `height` is drawCssHeight in a draw, which reads the page once a pass. */
  function drawFrame(height = canvasCssHeight): { current: SphereCameraFrame; uniforms: SphereCameraFrame } | null {
    const id = engine.frameId;
    const presentation = presentationView();
    const lean = experiments.bookkeeping;
    const key = lean ? "" : cameraKey(height);
    // Always evaluated, so the inputs it keeps are this draw's.
    const inputsChanged = lean && cameraInputsChanged(height);
    if (!frameCache || frameCache.id !== id || frameCache.key !== key || inputsChanged || frameCache.presentation !== presentation) {
      const frame = currentFrame(presentation, height);
      frameCache = { id, key, presentation, frame };
      if (!frame) {
        // Nothing to keep.
      } else if (lean && delayFrames === 0) {
        // Without a delay only this frame is read; the history waits for a check that asks for one.
        history.length = 0;
        historyFrameId = -1;
      } else {
        // A camera moved within a rendered frame replaces that frame's entry.
        if (historyFrameId === id && history.length > 0) history[0] = frame;
        else {
          history.unshift(frame);
          history.length = Math.min(history.length, 8);
          historyFrameId = id;
        }
      }
    }
    const current = frameCache.frame;
    if (!current) return null;
    const uniforms = history[Math.min(delayFrames, history.length - 1)] ?? current;
    return { current, uniforms };
  }

  function record(target: string, current: SphereCameraFrame, uniforms: SphereCameraFrame): void {
    if (!keepingRecords()) return;
    records.push({ frameId: engine.frameId, target, cameraRevision: current.revision, uniformRevision: uniforms.revision });
    if (records.length >= 2 * RECORDS_KEPT) records.splice(0, records.length - RECORDS_KEPT);
  }

  const quadData = new VertexData();
  quadData.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  quadData.indices = [0, 1, 2, 0, 2, 3];
  const triangleData = new VertexData();
  triangleData.positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
  triangleData.indices = [0, 1, 2];

  const placeholder = available
    ? RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene, false, false)
    : null;

  /** Every orb material, overlays and probes included, so the shader variant follows the experiment. */
  const orbMaterials = new Set<ShaderMaterial>();
  function withLeanDefine(defines: string[], lean: boolean): string[] {
    const others = defines.filter(define => define !== LEAN_DEFINE);
    return lean ? [...others, LEAN_DEFINE] : others;
  }
  function orbMaterial(name: string, defines: string[], reveal: boolean): ShaderMaterial {
    const material = new ShaderMaterial(name, scene, { vertexSource: webGpu ? ORB_VERTEX : ORB_VERTEX_GLSL, fragmentSource: webGpu ? ORB_FRAGMENT : ORB_FRAGMENT_GLSL }, {
      attributes: ["position"],
      uniforms: webGpu ? [...ORB_UNIFORMS] : [...ORB_UNIFORMS, ...ORB_LEAN_UNIFORMS],
      samplers: ["sphereCube", "sphereEquirect", ...TILE_SAMPLERS],
      defines: withLeanDefine([...backendDefines, ...defines], leanShaders()),
      shaderLanguage,
      needAlphaBlending: !defines.some(define => define.includes("OUTPUT_")),
    });
    material.onCompiled = onCompiled;
    material.onError = onError;
    material.backFaceCulling = false;
    if (reveal) {
      material.depthFunction = Constants.ALWAYS;
      material.disableDepthWrite = true;
    }
    orbMaterials.add(material);
    material.onDisposeObservable.addOnce(() => orbMaterials.delete(material));
    return material;
  }

  interface OrbInternal extends SphereOrb {
    state: OrbState;
    expansion: OrbExpansion | null;
    mesh: Mesh;
    revealMesh: Mesh;
    material: ShaderMaterial;
    revealMaterial: ShaderMaterial;
    /** The overlay's material for an equirectangular source, made when one is first drawn. */
    revealEquirectMaterial: ShaderMaterial | null;
    /** The overlay's material for a tiled source. */
    revealTilesMaterial: ShaderMaterial | null;
    /** Draws the orb's preview, or `source` in its place. */
    applyUniforms(material: ShaderMaterial, uniforms: SphereCameraFrame, radius: number, opacity: number, source?: ImmersionSource | null): boolean;
    /** The radius drawn at `distance` in `frame`: the screen-size bounds, then the display scale. */
    drawnRadius(distance: number, frame: SphereCameraFrame): number;
  }

  function applyContent(material: ShaderMaterial, content: Mat3, prefix = "content"): void {
    content.forEach((row, index) => material.setVector3(`${prefix}${index}`, toVector(row) as never));
  }

  /** A tiled source's atlas, table and layout, under the names its shader takes: `tile…`, or `nextTile…`. */
  function applyTiles(material: ShaderMaterial, tiles: TiledSourceTextures, next = false): void {
    const prefix = next ? "nextTile" : "tile";
    material.setTexture(`${prefix}Atlas`, tiles.atlas);
    material.setTexture(`${prefix}Table`, tiles.table);
    material.setVector4(`${prefix}Layout`, new Vector4(...tiles.layout));
    material.setVector4(`${prefix}AtlasInfo`, new Vector4(tiles.atlasSize[0], tiles.atlasSize[1], tiles.warp === "equi-angular" ? 1 : 0, tiles.outlines ? 1 : 0));
  }

  function addOrb(id: string, initial: OrbState): SphereOrb {
    if (!available) {
      // No GPU drawing; the scene list still shows the sphere.
      return { id, update() {}, setExpansion() {}, effectiveRadius: () => null, dispose() {} };
    }
    const mesh = new Mesh(`sphere-orb-${id}`, scene);
    quadData.applyToMesh(mesh);
    const revealMesh = new Mesh(`sphere-orb-reveal-${id}`, scene);
    quadData.applyToMesh(revealMesh);
    for (const each of [mesh, revealMesh]) {
      // The shader positions this quad itself, so Babylon's mesh bounds are
      // unrelated. Test the actual shader quad for each camera pass instead.
      each.isInFrustum = () => {
        // A tracked headset may draw several eyes from one evaluation.
        if (headTracked()) return true;
        const frames = drawFrame(drawCssHeight), marker = orb.state.marker;
        if (!frames || !marker) return true;
        const rel = sub(marker, frames.uniforms.eye);
        const radius = orb.expansion?.radiusMeters ?? orb.drawnRadius(length(rel), frames.uniforms);
        return !orbQuadOutsideView(orbQuad(rel, radius, frames.uniforms, options.getCamera()?.minZ ?? NEAR_PLANE_WITHOUT_CAMERA, orb.state.outline?.widthPx ?? 0), frames.uniforms.viewRotProj);
      };
      each.isPickable = false;
      each.doNotSyncBoundingInfo = true;
    }
    // Drawn with the terrain, so it is depth tested against it; the reveal draws later, over everything.
    revealMesh.renderingGroupId = 1;
    revealMesh.setEnabled(false);
    const material = orbMaterial(`sphere-orb-material-${id}`, [], false);
    const revealMaterial = orbMaterial(`sphere-orb-reveal-material-${id}`, [], true);
    mesh.material = material;
    revealMesh.material = revealMaterial;
    const outlineColor = new Color4();

    const orb: OrbInternal = {
      id,
      state: { ...initial },
      expansion: null,
      mesh,
      revealMesh,
      material,
      revealMaterial,
      revealEquirectMaterial: null,
      revealTilesMaterial: null,
      applyUniforms(target, uniforms, radius, opacity, source) {
        const marker = orb.state.marker;
        if (!marker) return false;
        const rel = sub(marker, uniforms.eye);
        const near = options.getCamera()?.minZ ?? NEAR_PLANE_WITHOUT_CAMERA;
        const outline = orb.state.outline;
        const quad = orbQuad(rel, radius, uniforms, near, outline?.widthPx ?? 0);
        target.setMatrix("viewRotProj", uniforms.viewRotProj);
        target.setVector3("quadCenter", toVector(quad.center) as never);
        target.setVector3("quadU", toVector(quad.u) as never);
        target.setVector3("quadV", toVector(quad.v) as never);
        target.setVector3("markerRel", toVector(rel) as never);
        target.setFloat("radius", radius);
        const tanPreviewHalfAngle = Math.tan((appearance.previewFovDeg * Math.PI) / 360);
        target.setFloat("tanPreviewHalfAngle", tanPreviewHalfAngle);
        if (leanShaders()) {
          const constants = orbDrawConstants(rel, radius, tanPreviewHalfAngle);
          target.setFloat("sinAlpha", constants.sinAlpha);
          target.setFloat("windowGain", constants.windowGain);
          target.setFloat("identityWindow", constants.identityWindow ? 1 : 0);
        }
        target.setFloat("opacity", opacity);
        // The shader measures the outline in the pixels it draws.
        const devicePerCss = engine.getRenderHeight() * (options.getCamera()?.viewport.height ?? 1) / Math.max(1, uniforms.viewportHeightCssPx);
        const [r, g, b, a] = outline?.color ?? [0, 0, 0, 0];
        target.setColor4("outlineColor", outlineColor.set(r, g, b, a));
        target.setFloat("outlineWidth", (outline?.widthPx ?? 0) * devicePerCss);
        applyContent(target, source?.content ?? orb.state.content);
        if (source?.kind === "equirectangular") target.setTexture("sphereEquirect", source.texture);
        else target.setTexture("sphereCube", source?.texture ?? orb.state.texture ?? placeholder!);
        if (source?.kind === "tiles" && source.tiles) applyTiles(target, source.tiles);
        return true;
      },
      update(state) {
        Object.assign(orb.state, state);
        const drawable = orb.state.visible && orb.state.marker !== null && orb.state.texture !== null;
        mesh.setEnabled(drawable);
        revealMesh.setEnabled(orb.state.visible && orb.expansion !== null && orb.state.marker !== null && (orb.expansion.source?.texture ?? orb.state.texture) !== null);
        options.requestRender();
      },
      setExpansion(expansion) {
        orb.expansion = expansion;
        if (expansion?.source?.kind === "equirectangular") {
          orb.revealEquirectMaterial ??= orbMaterial(`sphere-orb-reveal-equirect-material-${id}`, ["#define SOURCE_EQUIRECT"], true);
          revealMesh.material = orb.revealEquirectMaterial;
        } else if (expansion?.source?.kind === "tiles") {
          orb.revealTilesMaterial ??= orbMaterial(`sphere-orb-reveal-tiles-material-${id}`, ["#define SOURCE_TILES"], true);
          revealMesh.material = orb.revealTilesMaterial;
        } else revealMesh.material = revealMaterial;
        revealMesh.setEnabled(orb.state.visible && expansion !== null && orb.state.marker !== null && (expansion.source?.texture ?? orb.state.texture) !== null);
        options.requestRender();
      },
      drawnRadius(distance, frame) {
        return effectiveOrbRadius(orb.state.radiusMeters, distance, frame, appearance.markerDiameterCssPx) * orb.state.displayScale;
      },
      effectiveRadius(frame) {
        const f = frame ?? drawFrame()?.current ?? null;
        if (!f || !orb.state.marker) return null;
        return orb.drawnRadius(length(sub(orb.state.marker, f.eye)), f);
      },
      dispose() {
        orbs.delete(id);
        mesh.onBeforeRenderObservable.remove(observer);
        revealMesh.onBeforeRenderObservable.remove(revealObserver);
        mesh.dispose();
        revealMesh.dispose();
        material.dispose();
        revealMaterial.dispose();
        orb.revealEquirectMaterial?.dispose();
        orb.revealTilesMaterial?.dispose();
        options.requestRender();
      },
    };
    const observer: Observer<Mesh> | null = mesh.onBeforeRenderObservable.add(timed(() => {
      const frames = drawFrame(drawCssHeight);
      if (!frames) return;
      // Expanding, the orb is the whole ball, clipped by terrain where its overlay has not yet revealed it.
      const radius = orb.expansion?.radiusMeters ?? orb.drawnRadius(length(sub(orb.state.marker ?? frames.uniforms.eye, frames.uniforms.eye)), frames.uniforms);
      const opacity = orb.state.opacity ?? 1;
      material.disableDepthWrite = opacity < 0.999;
      if (orb.applyUniforms(material, frames.uniforms, radius, opacity)) record(`orb:${id}`, frames.current, frames.uniforms);
    }));
    const revealObserver: Observer<Mesh> | null = revealMesh.onBeforeRenderObservable.add(timed(() => {
      const frames = drawFrame(drawCssHeight);
      if (!frames || !orb.expansion) return;
      const kind = orb.expansion.source?.kind;
      const target = kind === "equirectangular" ? orb.revealEquirectMaterial! : kind === "tiles" ? orb.revealTilesMaterial! : revealMaterial;
      if (orb.applyUniforms(target, frames.uniforms, orb.expansion.radiusMeters, orb.expansion.reveal * (orb.state.opacity ?? 1), orb.expansion.source)) record(`reveal:${id}`, frames.current, frames.uniforms);
    }));
    orbs.set(id, orb);
    orb.update({});
    return orb;
  }

  // ─── Immersion ──────────────────────────────────────────────────────
  const immersionMesh = available ? new Mesh("sphere-immersion", scene) : null;
  const immersionMaterials = new Map<string, ShaderMaterial>();
  let immersionState: { source: ImmersionSource; next: ImmersionSource | null; mix: number; opacity: number; view: NavigationPresentation | null } | null = null;
  /** A host multiplier over the fade opacity, so a placement tool can ghost the photograph. */
  let displayOpacity = 1;
  /** `opaque`: drawn without blending, for immersion at full opacity (the opaqueImmersion experiment). */
  function immersionMaterial(defines: string[], opaque = false): ShaderMaterial {
    const all = withLeanDefine(defines, leanShaders());
    const key = all.join(" ") + (opaque ? " opaque" : "");
    let material = immersionMaterials.get(key);
    if (!material) {
      material = new ShaderMaterial(`sphere-immersion-${key || "cube"}`, scene, { vertexSource: webGpu ? IMMERSION_VERTEX : IMMERSION_VERTEX_GLSL, fragmentSource: webGpu ? IMMERSION_FRAGMENT : IMMERSION_FRAGMENT_GLSL }, {
        attributes: ["position"],
        uniforms: webGpu ? [...IMMERSION_UNIFORMS] : [...IMMERSION_UNIFORMS, ...IMMERSION_LEAN_UNIFORMS],
        samplers: ["sphereCube", "sphereEquirect", "nextCube", "nextEquirect", ...TILE_SAMPLERS, ...NEXT_TILE_SAMPLERS],
        defines: [...backendDefines, ...all],
        shaderLanguage,
        needAlphaBlending: !opaque && !defines.some(define => define.includes("OUTPUT_")),
      });
      material.onCompiled = onCompiled;
      material.onError = onError;
      material.backFaceCulling = false;
      material.depthFunction = Constants.ALWAYS;
      material.disableDepthWrite = true;
      immersionMaterials.set(key, material);
    }
    return material;
  }
  function immersionDefines(state: { source: ImmersionSource; next: ImmersionSource | null }, output?: "direction" | "ray"): string[] {
    const defines: string[] = [];
    if (state.source.kind === "equirectangular") defines.push("#define SOURCE_EQUIRECT");
    // A tiled cube draws over its preview cube: the cube's path, and its tiles.
    if (state.source.kind === "tiles") defines.push("#define SOURCE_TILES");
    if (state.next) defines.push(state.next.kind === "equirectangular" ? "#define NEXT_EQUIRECT" : "#define NEXT_CUBE");
    if (state.next?.kind === "tiles") defines.push("#define NEXT_TILES");
    if (output) defines.push(output === "direction" ? "#define OUTPUT_DIRECTION" : "#define OUTPUT_RAY");
    return defines;
  }
  function applyImmersionUniforms(material: ShaderMaterial, uniforms: SphereCameraFrame): void {
    const state = immersionState;
    if (!state) return;
    material.setMatrix("inverseViewRotProj", uniforms.inverseViewRotProj);
    material.setFloat("opacity", state.opacity * displayOpacity);
    material.setFloat("mixWeight", state.mix);
    applyContent(material, state.source.content);
    applyContent(material, (state.next ?? state.source).content, "nextContent");
    if (leanShaders()) {
      material.setMatrix("imageFromClip", imageFromClipMatrix(uniforms.inverseViewRotProj, state.source.content, new Matrix()));
      material.setMatrix("nextImageFromClip", imageFromClipMatrix(uniforms.inverseViewRotProj, (state.next ?? state.source).content, new Matrix()));
    }
    material.setTexture(state.source.kind === "equirectangular" ? "sphereEquirect" : "sphereCube", state.source.texture);
    if (state.source.kind === "tiles" && state.source.tiles) applyTiles(material, state.source.tiles);
    if (state.next) material.setTexture(state.next.kind === "equirectangular" ? "nextEquirect" : "nextCube", state.next.texture);
    if (state.next?.kind === "tiles" && state.next.tiles) applyTiles(material, state.next.tiles, true);
  }
  if (immersionMesh) {
    triangleData.applyToMesh(immersionMesh);
    immersionMesh.alwaysSelectAsActiveMesh = true;
    immersionMesh.isPickable = false;
    immersionMesh.doNotSyncBoundingInfo = true;
    immersionMesh.renderingGroupId = 2;
    // Drawn by the globe camera normally and while it shows only the presentation layer.
    immersionMesh.layerMask = 0x0fffffff | options.presentationLayerMask;
    immersionMesh.setEnabled(false);
    immersionMesh.onBeforeRenderObservable.add(timed(() => {
      if (!immersionState) return;
      const material = immersionMesh.material as ShaderMaterial | null;
      if (!material) return;
      const fade = immersionView();
      const override = fade ? currentFrame(fade, drawCssHeight) : null;
      const frames = override ? { current: override, uniforms: override } : drawFrame(drawCssHeight);
      if (!frames) return;
      applyImmersionUniforms(material, frames.uniforms);
      record("immersion", frames.current, frames.uniforms);
    }));
  }
  /** The immersion's material for its state and the experiments now. */
  function applyImmersionMaterial(): void {
    if (!immersionMesh || !immersionState) return;
    // The crossfade blends inside the shader; only a fade from the globe needs the frame behind.
    const opaque = experiments.opaqueImmersion && immersionState.opacity * displayOpacity >= 0.999;
    immersionMesh.material = immersionMaterial(immersionDefines(immersionState), opaque);
  }
  const immersion: SphereImmersion = {
    show(state) {
      if (!immersionMesh) return;
      immersionState = state ? { source: state.source, next: state.next ?? null, mix: state.mix ?? 0, opacity: state.opacity ?? 1, view: state.view ?? null } : null;
      applyImmersionMaterial();
      immersionMesh.setEnabled(immersionState !== null);
      options.requestRender();
    },
    setOpacity(opacity) {
      displayOpacity = Math.min(1, Math.max(0, opacity));
      applyImmersionMaterial();
      options.requestRender();
    },
    replaceContent(content) {
      if (!immersionState) return;
      immersionState = { ...immersionState, source: { ...immersionState.source, content } };
      options.requestRender();
    },
    get visible() { return immersionState !== null; },
  };

  // ─── Picking and projection ─────────────────────────────────────────
  /** The camera's viewport on the page: the world's part of a canvas that other surfaces can share. */
  function viewportRect(): { left: number; top: number; width: number; height: number } | null {
    const canvas = engine.getRenderingCanvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const viewport = options.getCamera()?.viewport;
    if (!viewport) return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    // Babylon measures the viewport from the bottom.
    return {
      left: rect.left + viewport.x * rect.width,
      top: rect.top + (1 - viewport.y - viewport.height) * rect.height,
      width: viewport.width * rect.width,
      height: viewport.height * rect.height,
    };
  }

  function rayThrough(frame: SphereCameraFrame, clientX: number, clientY: number): Vec3 | null {
    const rect = viewportRect();
    if (!rect) return null;
    const x = (clientX - rect.left) / Math.max(1, rect.width);
    const y = (clientY - rect.top) / Math.max(1, rect.height);
    const tanHalf = Math.tan(frame.view.verticalFovRad / 2);
    return normalize(add(frame.view.forward, add(scale(frame.view.right, (2 * x - 1) * tanHalf * frame.view.aspect), scale(frame.view.up, (1 - 2 * y) * tanHalf))));
  }

  function pick(clientX: number, clientY: number, isOccluded: (eye: Vec3, direction: Vec3, distance: number) => boolean): OrbHit[] {
    const frame = currentFrame();
    if (!frame) return [];
    const ray = rayThrough(frame, clientX, clientY);
    if (!ray) return [];
    return hitsAlong(frame, frame.eye, ray, isOccluded);
  }

  function pickRay(origin: Vec3, direction: Vec3, isOccluded: (eye: Vec3, direction: Vec3, distance: number) => boolean): OrbHit[] {
    const frame = currentFrame();
    const size = length(direction);
    if (!frame || !(size > 0)) return [];
    return hitsAlong(frame, origin, scale(direction, 1 / size), isOccluded);
  }

  /** Orbs along a unit ray from `origin`, sized as `frame` draws them. */
  function hitsAlong(frame: SphereCameraFrame, origin: Vec3, ray: Vec3, isOccluded: (eye: Vec3, direction: Vec3, distance: number) => boolean): OrbHit[] {
    const tanHalf = Math.tan(frame.view.verticalFovRad / 2);
    const hitHalfAngle = Math.atan(((appearance.hitTargetDiameterCssPx / 2) * 2 * tanHalf) / Math.max(1, frame.viewportHeightCssPx));
    const hits: OrbHit[] = [];
    for (const orb of orbs.values()) {
      const marker = orb.state.marker;
      if (!marker || !orb.state.visible || !orb.state.texture) continue;
      const rel = sub(marker, origin);
      const d = length(rel);
      const radius = orb.drawnRadius(d, frame);
      if (d <= radius) continue;
      const axis = scale(rel, 1 / d);
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(axis, ray))));
      // The outline is part of what is drawn, so part of what a click selects.
      const outlineAngle = Math.atan(((orb.state.outline?.widthPx ?? 0) * 2 * tanHalf) / Math.max(1, frame.viewportHeightCssPx));
      const onSilhouette = angle <= Math.asin(radius / d) + outlineAngle;
      if (!onSilhouette && angle > hitHalfAngle) continue;
      const depth = d - radius;
      if (isOccluded(origin, axis, depth)) continue;
      hits.push({ id: orb.id, depthMeters: depth, onSilhouette });
    }
    return hits.sort((a, b) => Number(b.onSilhouette) - Number(a.onSilhouette) || a.depthMeters - b.depthMeters || (a.id < b.id ? -1 : 1));
  }

  /** Where a direction from the eye falls across the view, −1 to 1 on each axis, or null behind it or well outside. */
  function viewPoint(direction: Vec3, frame: SphereCameraFrame): { x: number; y: number } | null {
    const z = dot(direction, frame.view.forward);
    if (z <= 1e-6) return null;
    const tanHalf = Math.tan(frame.view.verticalFovRad / 2);
    const x = dot(direction, frame.view.right) / (z * tanHalf * frame.view.aspect);
    const y = dot(direction, frame.view.up) / (z * tanHalf);
    if (Math.abs(x) > 1.2 || Math.abs(y) > 1.2) return null;
    return { x, y };
  }

  function project(direction: Vec3, frame = currentFrame() ?? undefined): { x: number; y: number } | null {
    if (!frame) return null;
    const point = viewPoint(direction, frame);
    if (!point) return null;
    const rect = viewportRect();
    if (!rect) return null;
    return { x: rect.left + ((point.x + 1) / 2) * rect.width, y: rect.top + ((1 - point.y) / 2) * rect.height };
  }

  // `viewportRect` is null exactly when there is no canvas, so this needs no page box.
  function onScreen(direction: Vec3, frame = currentFrame() ?? undefined): boolean {
    return !!frame && viewPoint(direction, frame) !== null && engine.getRenderingCanvas() !== null;
  }

  // ─── Probe (tests) ──────────────────────────────────────────────────
  async function probe(target: { orb: string } | { immersion: true }, outputs: readonly SphereProbeOutput[]): Promise<SphereProbeResult> {
    if (!available) throw new Error(unavailableReason ?? "unavailable");
    if (outputs.length === 0) throw new Error("Ask for at least one output.");
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    const orb = "orb" in target ? orbs.get(target.orb) : null;
    if ("orb" in target && !orb) throw new Error(`No orb ${target.orb}`);
    if (!("orb" in target) && !immersionState) throw new Error("Immersion is not shown.");
    let captured: SphereCameraFrame | null = null;
    const passes = outputs.map(output => {
      const rtt = new RenderTargetTexture(`sphere-probe-${output}`, { width, height }, scene, false, true, Constants.TEXTURETYPE_FLOAT);
      // Unset, a render target clears to the scene's colour; the probe needs coverage 0 where nothing drew.
      rtt.clearColor = new Color4(0, 0, 0, 0);
      const mesh = new Mesh(`sphere-probe-mesh-${output}`, scene);
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.isPickable = false;
      mesh.doNotSyncBoundingInfo = true;
      mesh.layerMask = 0;
      const define = output === "direction" ? "#define OUTPUT_DIRECTION" : "#define OUTPUT_RAY";
      let material: ShaderMaterial;
      let observer: Observer<Mesh> | null;
      if (orb) {
        quadData.applyToMesh(mesh);
        material = orbMaterial(`sphere-probe-orb-${output}`, [define], false);
        observer = mesh.onBeforeRenderObservable.add(() => {
          const frames = drawFrame();
          if (!frames) return;
          captured = frames.current;
          const radius = orb.expansion?.radiusMeters ?? effectiveOrbRadius(orb.state.radiusMeters, length(sub(orb.state.marker ?? frames.uniforms.eye, frames.uniforms.eye)), frames.uniforms, appearance.markerDiameterCssPx);
          orb.applyUniforms(material, frames.uniforms, radius, 1);
        });
      } else {
        triangleData.applyToMesh(mesh);
        material = immersionMaterial(immersionDefines(immersionState!, output));
        observer = mesh.onBeforeRenderObservable.add(() => {
          const fade = immersionView();
          const override = fade ? currentFrame(fade) : null;
          const frames = override ? { current: override, uniforms: override } : drawFrame();
          if (!frames) return;
          captured = frames.current;
          applyImmersionUniforms(material, frames.uniforms);
        });
      }
      mesh.material = material;
      rtt.renderList = [mesh];
      rtt.activeCamera = options.getCamera();
      rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      return { output, rtt, mesh, material, observer, ownsMaterial: Boolean(orb) };
    });
    try {
      // A render target renders once and skips a mesh whose shader is not ready,
      // as a WebGL shader compiling in parallel is not on its first frames.
      await Promise.all(passes.map(pass => pass.material.forceCompilationAsync(pass.mesh)));
      for (const pass of passes) scene.customRenderTargets.push(pass.rtt);
      // Every pass renders in the same frame, so every output shares one camera.
      const rendered = Promise.all(passes.map(pass => new Promise<void>(resolve => { pass.rtt.onAfterRenderObservable.addOnce(() => resolve()); })));
      options.requestRender();
      await rendered;
      const results: Partial<Record<SphereProbeOutput, Float32Array>> = {};
      for (const pass of passes) {
        const pixels = await pass.rtt.readPixels(0, 0, null, true, false);
        if (!pixels) throw new Error("The probe read nothing back.");
        results[pass.output] = new Float32Array((pixels as Float32Array).buffer.slice(0));
      }
      if (!captured) throw new Error("The probe drew nothing.");
      return { width, height, outputs: results, frame: captured };
    } finally {
      for (const pass of passes) {
        const index = scene.customRenderTargets.indexOf(pass.rtt);
        if (index >= 0) scene.customRenderTargets.splice(index, 1);
        pass.mesh.onBeforeRenderObservable.remove(pass.observer);
        pass.mesh.dispose();
        if (pass.ownsMaterial) pass.material.dispose();
        pass.rtt.dispose();
      }
    }
  }

  return {
    available,
    unavailableReason,
    addOrb,
    immersion,
    setAppearance(next) {
      appearance = next;
      options.requestRender();
    },
    cameraFrame: view => (view && !headTracked() ? currentFrame(view) : drawFrame()?.current ?? currentFrame()),
    pick,
    pickRay,
    project,
    onScreen,
    probe,
    setExperiments(next) {
      const wasLean = leanShaders();
      Object.assign(experiments, next);
      if (leanShaders() !== wasLean) {
        // One compile for all orbs: materials with the same defines share an effect.
        for (const material of orbMaterials) material.options.defines = withLeanDefine(material.options.defines, leanShaders());
      }
      applyImmersionMaterial();
      frameCache = null;
      options.requestRender();
    },
    setUniformDelayFrames(frames) {
      delayFrames = Math.max(0, Math.min(7, Math.round(frames)));
    },
    captureDraws(capture) {
      captureDraws = capture;
    },
    drawRecords: () => (records.length > RECORDS_KEPT ? records.slice(-RECORDS_KEPT) : records),
    inspectOrb(id, frame) {
      const orb = orbs.get(id);
      if (!orb) return null;
      const { marker, radiusMeters, content, visible, texture } = orb.state;
      return { marker, radiusMeters, effectiveRadius: orb.effectiveRadius(frame), content, visible, textured: texture !== null };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const orb of [...orbs.values()]) orb.dispose();
      immersionMesh?.dispose();
      for (const material of immersionMaterials.values()) material.dispose();
      immersionMaterials.clear();
      placeholder?.dispose();
    },
  };
}
export * from "./rectangleRenderer.js";
export * from "./sphereRenderer.js";
