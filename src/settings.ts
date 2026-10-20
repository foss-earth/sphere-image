import type { DeviceContext, ParameterBounds, ParameterSpec, ParameterUnit } from "@foss-earth/ui/settings";
import { FLIGHT_GROWTH } from "./flight.js";

export const SCENES_TAB = "scenes";
/** The tab of the sphere on screen, titled with its image's title. */
export const SPHERE_TAB = "panorama";
/** Shown only inside a sphere. */
export const SPHERE_SETTINGS_TAB = "panorama-settings";
/** Optional navigation markers shared by the full panorama and its previews. */
export const SHOW_IMAGE_ANCHORS_ID = "scene.panorama.showAnchors";

/** Viewer-owned experiments retain their existing Renderer tab home. */
export const VIEWER_EXPERIMENT_IDS = {
  sphereBookkeeping: "renderer.experiments.panoramaBookkeeping",
  opaqueImmersion: "renderer.experiments.opaqueImmersion",
  sphereShaders: "renderer.experiments.panoramaShaders",
} as const;

const EXPERIMENT_REASON = "Under A/B validation: meant to draw the same picture with less work, not yet confirmed on devices.";
const experimentHome = { tab: "renderer", section: "experiments", level: "main" } as const;

/** The Renderer section displays these records; 360 owns their behavior. */
export const VIEWER_EXPERIMENT_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: VIEWER_EXPERIMENT_IDS.sphereBookkeeping,
    label: "Panorama draws without test records",
    description: "Stops recording every panorama draw, its camera as text and earlier frames' uniforms, which only the renderer's own checks read; a check turns recording back on. Review candidate 5.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: EXPERIMENT_REASON,
    home: experimentHome,
    appliesLive: true,
    source: "src/engine/babylon/panorama/panoramaRenderer.ts",
  },
  {
    id: VIEWER_EXPERIMENT_IDS.opaqueImmersion,
    label: "Opaque panorama",
    description: "Draws a panorama shown at full opacity without blending it over the frame behind, crossfades between two of its images included; fades from the globe still blend. Review candidate 6.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: EXPERIMENT_REASON,
    home: experimentHome,
    appliesLive: true,
    source: "src/engine/babylon/panorama/panoramaRenderer.ts",
  },
  {
    id: VIEWER_EXPERIMENT_IDS.sphereShaders,
    label: "Simpler panorama shaders",
    description: "WebGL only: works out each orb's per-draw constants once on the CPU instead of in every pixel, turns the panorama's view into the image's frame in the vertex shader, and normalizes each ray once or, for a cube, not at all. Review candidate 7.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: EXPERIMENT_REASON,
    home: experimentHome,
    appliesLive: true,
    source: "src/engine/babylon/panorama/panoramaRenderer.ts",
  },
];

const LOADER = "src/scenes/loadScene.ts";
const RENDERER = "src/engine/babylon/panorama/panoramaRenderer.ts";
const INPUT = "src/scenes/panoramaInput.ts";
const PROVISIONAL = "A provisional development value chosen to exercise a bounded path; not measured on a device.";
const TEXELS_PER_PX: ParameterUnit = { id: "texels-per-px", text: "texels/px" };
const CSS_PX: ParameterUnit = { id: "css-px", text: "CSS px" };

/** The device's largest 2D texture side, bounding sizes that become one texture. */
function textureSideBounds(min: number, cap: number): (context: DeviceContext) => ParameterBounds {
  return context => (context.maxTextureSize
    ? { min, max: Math.max(min, Math.min(cap, context.maxTextureSize)), reason: `this renderer's largest texture is ${context.maxTextureSize} px` }
    : { min, max: cap, reason: "the renderer's texture limit is not known until it starts" });
}

/** WebGPU's default largest texture side, assumed until the renderer reports its own. */
const DEFAULT_TEXTURE_SIDE = 8192;

/** The widest whole sphere the renderer can hold: an equirectangular image as wide as its texture limit. */
function widestImage(context: DeviceContext): { width: number; from: string } {
  return context.maxTextureSize
    ? { width: context.maxTextureSize, from: `this renderer's ${context.maxTextureSize} px texture limit` }
    : { width: DEFAULT_TEXTURE_SIDE, from: `${DEFAULT_TEXTURE_SIDE} px, WebGPU's default texture limit, until the renderer reports its own` };
}
interface Quantity {
  id: string;
  label: string;
  description: string;
  unit: ParameterUnit;
  min: number;
  max: number;
  fallback: number;
  reason: string;
  tab?: string;
  section: string;
  source: string;
  level?: "main" | "all";
  scale?: "linear" | "log2";
  step?: number;
}

function quantity(spec: Quantity): ParameterSpec {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    unit: spec.unit,
    kind: "number",
    bounds: () => ({ min: spec.min, max: spec.max }),
    scale: spec.scale ?? "linear",
    ...(spec.step !== undefined ? { step: spec.step } : {}),
    default: spec.fallback,
    defaultReason: spec.reason,
    home: { tab: spec.tab ?? SCENES_TAB, section: spec.section, level: spec.level ?? "main" },
    appliesLive: true,
    source: spec.source,
  };
}

/** Scenes → Orbs: how the orbs on the globe look and are picked. */
const APPEARANCE: readonly ParameterSpec[] = [
  quantity({
    id: "scene.panorama.previewFov", label: "Orb window angle", unit: "deg", min: 30, max: 150, fallback: 90, step: 1, section: "appearance",
    description: "How much of the panorama an orb shows at once, as a flat window toward it. Wider shows more and bends it less on entry.",
    reason: "The CPU visual contract's baseline, a 90° flat window.", source: RENDERER,
  }),
  quantity({
    id: "scene.panorama.previewDensity", label: "Orb image sharpness", unit: TEXELS_PER_PX, min: 0.25, max: 4, fallback: 1, scale: "log2", step: 0.25, section: "appearance",
    description: "Image texels per rendered pixel at an orb's centre, as it is drawn, that preview loading aims for. Higher loads larger previews.",
    reason: "One texel per pixel, an understandable heuristic; centre density is not a bound on the rim.", source: LOADER,
  }),
  {
    id: "scene.panorama.previewFaceRange", label: "Preview cube size", description: "The smallest and largest preview cube faces that may be loaded for orbs. Each orb shows its smallest allowed preview first. An orb on screen that is drawn with more pixels than that loads the preview its size asks for at the orb image sharpness, the largest orb first, and entering a panorama loads its largest.",
    unit: "px", kind: "range", bounds: textureSideBounds(16, 2048), step: 1, scale: "log2",
    default: { min: 64, max: 256 }, defaultReason: "A 64 px cube is as sharp as an orb at its smallest on most screens, so a whole scene's first previews are small; 256 px serves an orb at its largest and the moment a panorama opens.",
    home: { tab: SCENES_TAB, section: "appearance", level: "main" }, appliesLive: true, source: LOADER,
  },
  {
    id: "scene.panorama.previewHold", label: "Sharper orb previews kept for",
    description: "How long an orb keeps a preview sharper than it needs once it is drawn smaller again or leaves the view. Then it goes back to the preview its size needs and gives the sharper one up, which Kept on the GPU when not shown (Loading and memory) holds or frees. While the scene is open keeps every sharper preview an orb has loaded.",
    unit: "s", kind: "number", named: [{ id: "scene", label: "While the scene is open" }], bounds: () => ({ min: 0, max: 600 }), step: 1, scale: "linear",
    default: 10, defaultReason: "Long enough to pan away and back over the same orbs without loading them again, short enough that the part of the map you have left soon gives its memory back. " + PROVISIONAL,
    home: { tab: SCENES_TAB, section: "appearance", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.markerRadiusMeters", label: "Orb radius", unit: "m", min: 0.1, max: 100, fallback: 1, scale: "log2", step: 0.25, section: "appearance",
    description: "The size of an orb whose scene gives none. The on-screen size limits below still apply.",
    reason: "A metre: a person-sized marker.", source: RENDERER,
  }),
  {
    id: "scene.panorama.markerDiameter", label: "Orb size on screen", description: "The smallest and largest an orb is drawn, whatever its distance; its effective radius follows, for drawing, depth and picking alike.",
    unit: CSS_PX, kind: "range", bounds: () => ({ min: 4, max: 256 }), step: 1, scale: "log2",
    default: { min: 24, max: 96 }, defaultReason: "Prototype discoverability; a portrait-phone trial has not been run.",
    home: { tab: SCENES_TAB, section: "appearance", level: "main" }, appliesLive: true, source: RENDERER,
  },
  quantity({
    id: "scene.panorama.hitTargetDiameter", label: "Orb touch target", unit: CSS_PX, min: 24, max: 96, fallback: 44, step: 1, section: "appearance",
    description: "How close to a small orb's centre a click or tap still selects it. Where several are that close, the Scenes list offers them.",
    reason: "44 px, the common minimum touch target, as a separate tolerance from the drawn silhouette.", source: LOADER,
  }),
];

/**
 * Scenes → Motion: the animations between the globe and a sphere, and the
 * reduced-motion choice that governs them all. They play on the globe side
 * too, so they stay where the globe can reach them.
 */
const MOTION: readonly ParameterSpec[] = [
  quantity({
    id: "scene.panorama.hoverDuration", label: "Hover growth", unit: "ms", min: 0, max: 1000, fallback: 120, step: 10, section: "motion",
    description: "How long an orb takes to grow while the pointer is over it, and to shrink back, when its scene asks it to grow; 0 jumps.",
    reason: "Quick enough to follow the pointer, long enough to read as growth; visual check pending.", source: LOADER,
  }),
  {
    id: "scene.panorama.flightDuration", label: "Fly into and out of 360 images",
    description: "How long the camera takes to fly into an orb when its 360 image is entered, and to pull back out of it, facing the way the view faces, when it is left. Cut short by a press, a swipe or Escape, the map takes the camera where it got to, still moving, and slows it as its glide does (Camera → Glide); the swipe or drag goes on moving it. Off opens the orb where it stands (Entry reveal) and fades back to the map view it was entered from.",
    unit: "ms", kind: "number", named: [{ id: "off", label: "Off" }], bounds: () => ({ min: 100, max: 5000 }), step: 50, scale: "linear",
    default: 1000, defaultReason: "On, as asked: a second is long enough to follow the camera in and out, and short enough not to wait on; motion trial pending.",
    home: { tab: SCENES_TAB, section: "motion", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.flightGrowth", label: "Orb growth", unit: "ratio", min: 0, max: 1, fallback: FLIGHT_GROWTH, step: 0.05, section: "motion",
    description: "How much of flying into or out of a 360 image the orb does by growing or shrinking, the camera's flight doing the rest: 0 flies all the way to an orb that keeps its size; 1 grows the orb around a camera that only turns. The orb looks the same on screen either way; more growth keeps the camera farther from the ground, with less of the map to load near it.",
    reason: "As asked: the orb grows and shrinks while the camera flies, each doing half.", source: LOADER,
  }),
  quantity({
    id: "scene.panorama.expandDuration", label: "Entry reveal", unit: "ms", min: 0, max: 2000, fallback: 350, step: 10, section: "motion",
    description: "How long an orb takes to open out to the whole view on entry when the camera does not fly into it.", reason: "A short reveal prototype; motion trial pending.", source: LOADER,
  }),
  quantity({
    id: "scene.panorama.fadeDuration", label: "Fades", unit: "ms", min: 0, max: 1000, fallback: 150, step: 10, section: "motion",
    description: "How long exits without a flight, links, sharper images and entries without a visible orb take to fade.", reason: "A short blend; visual check pending.", source: LOADER,
  }),
  {
    id: "scene.panorama.reducedMotion", label: "Motion", description: "Whether panorama transitions animate, or cut with the short fade below.",
    unit: "none", kind: "choice",
    choices: [
      { id: "system", label: "As the system asks", description: "Follow the operating system's reduced-motion preference." },
      { id: "reduce", label: "Reduce", description: "Always cut or fade briefly; no flight, reveal, levelling or glide." },
    ],
    default: "system", defaultReason: "Respect the operating system, and allow a stricter choice here.",
    home: { tab: SCENES_TAB, section: "motion", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.reducedFadeDuration", label: "Reduced-motion fade", unit: "ms", min: 0, max: 250, fallback: 0, step: 10, section: "motion",
    description: "The fade used instead of animation when motion is reduced; 0 cuts.", reason: "A cut avoids animation.", source: LOADER,
  }),
];

const TILE_EVIDENCE = "benchmarks/eac-progressive-prototype";

/** The sphere's tab → Image detail: the one control the tab has, beside what it shows and why. */
const SPHERE: readonly ParameterSpec[] = [
  {
    id: "scene.panorama.immersionWidth", label: "Image detail",
    description: "The widest image loaded inside a panorama, in pixels around the whole turn: an equirectangular image's width, or four cube faces. The largest image a panorama offers up to this is shown, within the memory budgets; at its largest, only the renderer's texture limit applies.",
    unit: "px", kind: "number", scale: "log2", track: { reversed: true, ramp: "detail" },
    bounds: context => (context.maxTextureSize
      ? { min: 256, max: Math.max(256, context.maxTextureSize), reason: `this renderer's largest texture is ${context.maxTextureSize} px` }
      : { min: 256, max: 16384, reason: "the renderer's texture limit is not known until it starts" }),
    default: context => {
      const { width, from } = widestImage(context);
      return { value: width, derivedFrom: from };
    },
    defaultReason: "The most detailed image: each panorama opens at the largest image it offers. Lower it to spend less memory and download.",
    home: { tab: SPHERE_TAB, section: "detail", level: "main" }, appliesLive: true, source: LOADER,
  },
];

/** 360 image settings: what matters only inside a sphere. */
const SPHERE_SETTINGS: readonly ParameterSpec[] = [
  {
    id: "scene.panorama.representation", label: "Representation",
    description: "How the photograph arrives inside a panorama, where the panorama offers more than one kind. Tiles load the part of the view that needs them, at the detail it needs, so the view sharpens in a second or two; a whole image is sharp only once all of it has arrived. A panorama without the chosen kind shows the kind it has.",
    unit: "none", kind: "choice",
    choices: [
      { id: "equi-angular-tiles", label: "Equi-angular cube tiles", description: "A cube whose texels are spread evenly over each face: the fewest bytes for the same sharpness." },
      { id: "cube-tiles", label: "Cube tiles", description: "An ordinary cube map in the same tiles: coarser in the middle of each face, finer at its corners." },
      { id: "whole", label: "Whole image", description: "One equirectangular image, the largest the image detail allows." },
    ],
    default: "equi-angular-tiles",
    defaultReason: `Measured in ${TILE_EVIDENCE}: at 2 Mbit/s the view was within 1 dB of finished in 1.3 s with equi-angular tiles, where whole images of 4.7 and 5.5 MiB took 20 s and more; and cube tiles needed 15% more bytes for the same quality.`,
    home: { tab: SPHERE_SETTINGS_TAB, section: "image", level: "main" }, appliesLive: true, source: LOADER,
  },
  {
    id: "scene.panorama.immersionDensity", label: "Sharpness target",
    description: "Off, a panorama shows the largest image its image detail allows. A number loads instead the smallest image that gives this many image texels per rendered pixel at the centre of the view, which saves memory and download on small screens.",
    unit: TEXELS_PER_PX, kind: "number", named: [{ id: "off", label: "Off" }], bounds: () => ({ min: 0.25, max: 4 }), step: 0.25, scale: "log2",
    default: "off", defaultReason: "Off: the most detailed image, as the image detail asks.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "image", level: "main" }, appliesLive: true, source: LOADER,
  },
  {
    id: "scene.panorama.dragMode", label: "Drag",
    description: "Grab holds the touched image point under your finger. Scroll maps horizontal movement to heading and vertical movement to looking up or down, wherever the drag starts. Both keep the same release glide.",
    unit: "none", kind: "choice",
    choices: [
      { id: "grab", label: "Grab", description: "Keep the image point under the finger, with an upright horizon." },
      { id: "scroll", label: "Scroll", description: "Turn by the finger's movement, independent of where it touches, scaled with zoom." },
    ],
    default: "scroll", defaultReason: "Keeps dragging predictable from the top, middle and bottom of the screen.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "looking", level: "main" }, appliesLive: true, source: "src/look.ts",
  },
  {
    id: SHOW_IMAGE_ANCHORS_ID, label: "Show anchors",
    description: "Shows the image point held by a Grab drag or two-finger touch, and the point a zoom acts about, using the same markers as the map. Scroll drags have no anchor.",
    unit: "none", kind: "boolean", default: false,
    defaultReason: "Hidden by default, as asked; turn them on to see where gestures hold the image.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "looking", level: "main" }, appliesLive: true, source: "src/globeBrowserBindings.ts",
  },
  {
    id: "scene.panorama.verticalFovRange", label: "Zoom range", description: "The narrowest and widest vertical view inside a panorama.",
    unit: "deg", kind: "range", bounds: () => ({ min: 10, max: 150, reason: "The widest allowed vertical view is 150°; below 10° it magnifies past most sources." }), step: 1,
    default: { min: 20, max: 140 }, defaultReason: "As asked: close enough at 20° to look at detail, wide enough at 140° to take in most of the scene at once.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "looking", level: "main" }, appliesLive: true, source: INPUT,
  },
  {
    id: "scene.panorama.pitchRange", label: "Look up and down", description: "How far below and above the horizon you may look inside a panorama.",
    unit: "deg", kind: "range", bounds: () => ({ min: -89.9, max: 89.9, reason: "Looking exactly up or down leaves no heading to turn about." }), step: 0.1,
    default: { min: -85, max: 85 }, defaultReason: "Avoids the degenerate straight-up and straight-down looks.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "looking", level: "main" }, appliesLive: true, source: INPUT,
  },
  quantity({
    id: "scene.panorama.dragSensitivity", label: "Drag to look", unit: "deg/px", min: 0.01, max: 2, fallback: 0.15, scale: "log2", step: 0.05, tab: SPHERE_SETTINGS_TAB, section: "looking",
    description: "How far the view turns for each CSS pixel you drag when the panorama's viewport cannot be measured. With a measured viewport, Grab follows the touched image point and Scroll scales movement with the field of view and viewport height.", reason: "A fallback pointer gain for an unmeasured viewport.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.swipeSensitivity", label: "Swipe to look", unit: "deg/px", min: 0.01, max: 2, fallback: 0.15, scale: "log2", step: 0.05, tab: SPHERE_SETTINGS_TAB, section: "looking",
    description: "How far the view turns at a 90° field of view for each CSS pixel a two-finger trackpad swipe scrolls inside a panorama, scaled with the field of view's tangent as you zoom.",
    reason: "The same as dragging at a 90° field of view; scales with zoom.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.lookRate", label: "Key and stick look", unit: "deg/s", min: 1, max: 360, fallback: 90, scale: "log2", step: 0.1, tab: SPHERE_SETTINGS_TAB, section: "looking",
    description: "How fast arrow keys and a fully pushed stick turn the view.", reason: "A quarter turn a second.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.zoomPerNotch", label: "Wheel zoom", unit: "per-notch", min: 0.01, max: 1, fallback: 0.1, scale: "log2", step: 0.1, tab: SPHERE_SETTINGS_TAB, section: "looking",
    description: "How much one wheel notch narrows or widens the view, as a fraction of the view's tangent.", reason: "A tenth: multiplicative steps.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.zoomRate", label: "Key and trigger zoom", unit: "per-s", min: 0.01, max: 4, fallback: 0.5, scale: "log2", step: 0.1, tab: SPHERE_SETTINGS_TAB, section: "looking",
    description: "How fast held keys and triggers zoom, as a fraction of the view's tangent per second.", reason: "Halves or doubles the tangent in about 1.4 s.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.pinchGain", label: "Pinch zoom", unit: "ratio", min: 0.1, max: 4, fallback: 1, scale: "log2", step: 0.1, tab: SPHERE_SETTINGS_TAB, section: "looking",
    description: "How strongly spreading two fingers narrows the view; 1 keeps the image under your fingers.", reason: "One to one with finger separation.", source: INPUT,
  }),
  quantity({
    id: "scene.panorama.inertiaHalfLife", label: "Look glide", unit: "ms", min: 0, max: 1000, fallback: 100, step: 10, tab: SPHERE_SETTINGS_TAB, section: "looking",
    description: "How long the view keeps turning or zooming after a drag, swipe or zoom, as the time for its speed to halve; 0 stops at once.", reason: "A brief optional continuation.", source: INPUT,
  }),
  {
    id: "scene.panorama.entryOrientation", label: "On entering", description: "Where you look after entering: keep the heading and pitch you flew in with, or use the scene's suggested view. Opening view, below, can use a remembered or fixed look when moving between photographs.",
    unit: "none", kind: "choice",
    choices: [
      { id: "level-current", label: "Incoming direction", description: "Keep both the heading and pitch you came in with." },
      { id: "authored", label: "The scene's view", description: "Turn to the panorama's suggested view." },
    ],
    default: "level-current", defaultReason: "Keeps your bearing; a scene's view may be applied from the list.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "entering", level: "main" }, appliesLive: true, source: LOADER,
  },
  {
    id: "scene.panorama.openingView", label: "Opening view", description: "The view used by thumbnails and when moving between photographs. On entering uses the choice above. Last view uses the most recent look from any photograph. Each photograph keeps its own. One position uses the heading and pitch below. The Scenes list has Look up, which stores that position at the top of Look up and down. Entering from the map keeps the incoming direction ahead of these preferences.",
    unit: "none", kind: "choice",
    choices: [
      { id: "enter", label: "On entering", description: "Use the On entering choice." },
      { id: "last", label: "Last view", description: "Open where you were last looking, in any photograph." },
      { id: "image", label: "Each photograph", description: "Open where you were last looking in this photograph." },
      { id: "fixed", label: "One position", description: "Always open at the heading and pitch below." },
    ],
    default: "enter", defaultReason: "Leaves today's arrival unchanged until a remembered or fixed view is chosen.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "entering", level: "main" }, appliesLive: true, source: "src/app/openingView.ts",
  },
  {
    id: "scene.panorama.openingHeading", label: "Opening heading", description: "The heading used when Opening view is One position. 0 looks the same way heading 0 does in a panorama.",
    unit: "deg", kind: "number", bounds: () => ({ min: 0, max: 359.9 }), step: 0.1, scale: "linear",
    default: 0, defaultReason: "The panorama's forward heading.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "entering", level: "main" }, appliesLive: true, source: "src/app/openingView.ts",
    visibleWhen: { id: "scene.panorama.openingView", value: "fixed" },
  },
  {
    id: "scene.panorama.openingPitch", label: "Opening pitch", description: "The pitch used when Opening view is One position. Positive looks up, within Look up and down.",
    unit: "deg", kind: "number", bounds: () => ({ min: -89.9, max: 89.9 }), step: 0.1, scale: "linear",
    default: 0, defaultReason: "Level, until Look up stores the top of the pitch range.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "entering", level: "main" }, appliesLive: true, source: "src/app/openingView.ts",
    visibleWhen: { id: "scene.panorama.openingView", value: "fixed" },
  },
  {
    id: "scene.panorama.entryFov", label: "Field of view",
    description: "How much of a panorama you see, top to bottom, once you have entered it from the map, within the zoom range. The map's keeps the field of view the map had; the scene's view, when chosen above, brings its own.",
    unit: "deg", kind: "number", named: [{ id: "map", label: "The map's" }], bounds: () => ({ min: 10, max: 150 }), step: 1, scale: "linear",
    default: 120, defaultReason: "As asked: wide enough to see where you are as soon as you arrive; the flight in widens to it on the way.",
    home: { tab: SPHERE_SETTINGS_TAB, section: "entering", level: "main" }, appliesLive: true, source: LOADER,
  },
  quantity({
    id: "scene.panorama.orientDuration", label: "Levelling", unit: "ms", min: 0, max: 2000, fallback: 250, step: 10, tab: SPHERE_SETTINGS_TAB, section: "entering",
    description: "How long the view takes to level, turn or zoom to its field of view after entering. Flying in arrives level and with its field of view already, so only a turn to the scene's view is left for it.", reason: "A separate, short levelling phase.", source: LOADER,
  }),
];

export const VIEWER_PARAMETERS: readonly ParameterSpec[] = [...APPEARANCE, ...MOTION, ...SPHERE, ...SPHERE_SETTINGS, ...VIEWER_EXPERIMENT_PARAMETERS];
export const VIEWER_SECTION_TITLES: ReadonlyArray<readonly [string, string, string]> = [
  [SCENES_TAB, "appearance", "Orbs"], [SCENES_TAB, "motion", "Motion"],
  [SPHERE_TAB, "photograph", "Photograph"], [SPHERE_TAB, "links", "Links"], [SPHERE_TAB, "detail", "Image detail"],
  [SPHERE_SETTINGS_TAB, "image", "Image"], [SPHERE_SETTINGS_TAB, "looking", "Looking"], [SPHERE_SETTINGS_TAB, "entering", "Entering"],
];
