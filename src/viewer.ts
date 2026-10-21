/**
 * Retained orb/immersion transitions from loadScene, with document identity,
 * placement, history, transport, geography and device construction removed.
 * All animation steps run through the caller's renderer frame and clock.
 */
import { dot, length, scale, sub, type Vec3 } from "@foss-earth/images";
import type { ImageRepresentation } from "@foss-earth/images";
import { clampLook, createLookModel, type LookModel, type LookSettings, type LookState } from "./look.js";
import type { SphereViewport } from "./sphereCamera.js";
import { FLIGHT_GROWTH, flightIn, flightOut, flightMotion, flightProgress, flightProgressRate, poseView, type Flight, type FlightPose } from "./flight.js";
import { expansionTargetRadius, handoffReady, orbGeometry } from "./math.js";
import { interpolateView } from "./views.js";
import type { SettledPublishedImageViewer, PreparedViewerImage, ViewerAbortSignal, ViewerImageInput, ViewerLook, ViewerNavigationPresentation, ViewerNavigationSnapshot, ViewerPosePorts, ViewerStatus, ViewerWorldMath } from "./ports.js";
import type { ImmersionSource, OrbAppearance, SphereCameraFrame, SphereOrb, SphereRenderer } from "./renderer.js";

export interface ViewerSource {
  readonly key?: string;
  isCurrent?(): boolean;
  readonly representation: ImageRepresentation;
  readonly source: Omit<ImmersionSource, "content">;
  /** Host resource cache retains a reference; this releases only this user's hold. */
  release(): void;
  /** Called after the outgoing hold is released and the new source is visible. */
  settleReplacement(): void;
  /** Tiled sources consume this same frame; no independent scheduler. */
  onFrame?(frame: SphereCameraFrame, now: number, content: ViewerImageInput["placement"]["content"]): boolean;
  /** Progressive replacement stays behind a sharper whole source until its current view is covered. */
  viewReady?(): boolean;
  detail?(): { representation: string; loading?: string | null; limitation?: string | null; progress?: readonly string[] };
}
export interface ViewerSourceChoice { representation: ImageRepresentation; limitation: string | null; key?: string }
export interface ViewerResources {
  /** Optional entry warming: only an admissible tiled source. */
  warm?(input: ViewerImageInput, view: LookState): ViewerSourceChoice | null;
  preview(input: ViewerImageInput, diameterDevicePx: number | null): ViewerSourceChoice | null;
  immersion(input: ViewerImageInput, view: LookState, failed: ReadonlySet<string>): ViewerSourceChoice | null;
  acquire(input: ViewerImageInput, choice: ViewerSourceChoice, options: { signal: AbortSignal; priority: number; overlap: boolean }): Promise<ViewerSource>;
  faceTexels(representation: ImageRepresentation): number;
  whenSettled?(): Promise<void>;
}
export interface ViewerHeldPress { pointerId: number; button: number; clientX: number; clientY: number }
/** A finger down on the map, by its touch identifier, and where it is now. */
export interface ViewerHeldTouch { identifier: number; clientX: number; clientY: number }
export interface ViewerNavigationLease {
  readonly overview: ViewerNavigationSnapshot;
  readonly signal: AbortSignal;
  readonly released: boolean;
  setPresentationView(view: ViewerNavigationPresentation | null): void;
  holdRendering(): () => void;
  release(reason: "exit" | "cancelled" | "disposed"): void;
}
export interface ViewerNavigationPorts {
  acquire(): { ok: true; lease: ViewerNavigationLease } | { ok: false; message: string };
  place(lease: ViewerNavigationLease, pose: ViewerNavigationPresentation, marker: Vec3): void;
  restore(snapshot: ViewerNavigationSnapshot, lease?: ViewerNavigationLease): void;
  /** Must preserve position/velocity and continue the interrupting person's gesture. */
  glide(lease: ViewerNavigationLease, pose: ViewerNavigationPresentation, marker: Vec3, motion: {
    velocity: Vec3; turn: Vec3; fovRad: number; inputSince: number; press: ViewerHeldPress | null; touches?: readonly ViewerHeldTouch[] | null;
  }): void;
  /** The one host camera.inertiaDecay value, as a 60 Hz retained fraction. */
  inertiaDecay(): number;
  returnFocus(lease: ViewerNavigationLease): void;
}
export interface ViewerInputPorts {
  /** Host classifies fresh input; preceding wheel/trackpad momentum must not cancel. */
  cancelOnInput(controller: AbortController): { stop(): void; press(): ViewerHeldPress | null; touches?(): readonly ViewerHeldTouch[] | null };
  attach(options: { model: LookModel; lease: ViewerNavigationLease; requestFrame(): void; userInput(): void; exit(): void }): { detach(): void };
}
export interface ViewerSettings {
  appearance: OrbAppearance;
  look: LookSettings;
  entryOrientation: "authored" | "geographic";
  /** The vertical FOV, deg, a sphere entered from the map opens at, within the look's range; null or absent keeps the camera's. */
  entryFovDeg?: number | null;
  flightDurationMs: number;
  /** How much of a flight into or out of an orb the orb's growing or shrinking makes, 0 to 1 (`FLIGHT_GROWTH`, when absent). */
  flightGrowth?: number;
  expandDurationMs: number;
  fadeDurationMs: number;
  reducedFadeDurationMs: number;
  orientDurationMs: number;
  hoverDurationMs: number;
  /** null preserves previews while this image set is open. */
  previewHoldMs: number | null;
}
export interface ImageViewerOptions {
  renderer: Pick<SphereRenderer, "available" | "unavailableReason" | "addOrb" | "immersion" | "setAppearance" | "cameraFrame" | "pick" | "project"> & Partial<Pick<SphereRenderer, "pickRay" | "onScreen">>;
  resources: ViewerResources;
  world: ViewerWorldMath;
  poses: ViewerPosePorts;
  navigation: ViewerNavigationPorts;
  input: ViewerInputPorts;
  settings(): ViewerSettings;
  now(): number;
  devicePixelsPerCss(): number;
  /** The measured view, in CSS pixels. Live zoom uses the same rays as a tab; without it, zoom stays at the centre. */
  viewport?: () => SphereViewport | null;
  createAbortController(): AbortController;
  requestRender(): void;
  holdRendering(): () => void;
  isOccluded(eye: Vec3, direction: Vec3, distance: number): boolean;
  /** Host abort starts cancellation before borrowed device retirement. */
  signal?: AbortSignal;
  onRetirementError?(error: unknown): void;
  failure?(input: ViewerImageInput, kind: "preview" | "navigation" | "image", error: unknown): void;
}
interface Entry {
  input: ViewerImageInput;
  drawId: string;
  orb: SphereOrb;
  controller: AbortController;
  visible: boolean;
  disposed: boolean;
  preview: ViewerSource | null;
  previewLimitation: string | null;
  loading: Promise<void> | null;
  loadingController: AbortController | null;
  previewError: unknown;
  failedSharper: string | null;
  unneededSince: number | null;
  frozenPlacement: ViewerImageInput["placement"] | null;
  pendingPlacement: ViewerImageInput["placement"] | null;
  hover: number;
  offExternal(): void;
  pendingSettlements: Set<ViewerSource>;
}
interface Immersion {
  entry: Entry; shown: ViewerSource; lease: ViewerNavigationLease; look: LookModel;
  roll: number; detach(): void; stopLook(): void; offAbort(): void;
  refine: AbortController | null; refineWork: Promise<void> | null; refinePhase: "acquiring" | "covering" | "fading" | null; failed: Set<string>; leaving: boolean; limitation: string | null; loading: string | null;
}
interface Flying { flight: Flight; marker: Vec3; durationMs: number; startedMs: number; t: number; reveal(s: number): number; source?: ImmersionSource }
const smooth = (t: number): number => t * t * (3 - 2 * t);
const vector = (v: Vec3): { x: number; y: number; z: number } => ({ x: v[0], y: v[1], z: v[2] });
const presented = (pose: FlightPose): ViewerNavigationPresentation => ({ position: vector(pose.position), forward: vector(pose.forward), up: vector(pose.up), verticalFovRad: pose.verticalFovRad });
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => { if (!item || typeof item !== "object" || Object.isFrozen(item)) return; for (const next of Object.values(item)) freeze(next); Object.freeze(item); };
  freeze(copy); return copy;
}
function snapshotActions(input: ViewerImageInput["actions"]): ViewerImageInput["actions"] {
  const ids = new Set<string>();
  return Object.freeze(input.map(action => {
    if (!action.id || ids.has(action.id) || typeof action.activate !== "function") throw new Error("Image actions require unique stable IDs and host callbacks.");
    ids.add(action.id);
    return Object.freeze({ id: action.id, label: action.label, ...(action.direction ? { direction: immutable(action.direction) } : {}), activate: action.activate });
  }));
}
function snapshotInput(input: ViewerImageInput): ViewerImageInput {
  if (typeof input.id !== "string" || !input.id) throw new Error("A placed image requires a stable identity.");
  const actions = snapshotActions(input.actions);
  return Object.freeze({ ...input, asset: immutable(input.asset), pose: immutable(input.pose), placement: immutable(input.placement), credits: immutable(input.credits), ...(input.initialView ? { initialView: immutable(input.initialView) } : {}), ...(input.details ? { details: immutable(input.details) } : {}), actions: Object.freeze(actions) });
}

export function createImageViewer(options: ImageViewerOptions): SettledPublishedImageViewer {
  const { renderer, navigation } = options;
  const onScreen = (direction: Vec3, frame: SphereCameraFrame): boolean => renderer.onScreen ? renderer.onScreen(direction, frame) : renderer.project(direction, frame) !== null;
  const inFlight = new Set<Promise<unknown>>(), retirementErrors: unknown[] = [];
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.then(() => inFlight.delete(work), () => inFlight.delete(work));
    return work;
  };
  const attempt = (actions: readonly (() => void)[], message: string): void => {
    const errors: unknown[] = [];
    for (const action of actions) { try { action(); } catch (error) { errors.push(error); } }
    retirementErrors.push(...errors);
    if (errors.length) throw new AggregateError(errors, message);
  };
  const retirementFailure = (error: unknown): void => {
    retirementErrors.push(error);
    try { options.onRetirementError?.(error); } catch (reporting) { retirementErrors.push(reporting); }
  };
  const resources: ViewerResources = {
    warm: (...args) => options.resources.warm?.(...args) ?? null,
    preview: (...args) => options.resources.preview(...args), immersion: (...args) => options.resources.immersion(...args),
    faceTexels: record => options.resources.faceTexels(record), acquire: (...args) => track(options.resources.acquire(...args)),
  };
  const handles = new WeakMap<PreparedViewerImage, Entry>();
  const prepared = new Set<Entry>();
  let entries = new Map<string, Entry>();
  let serial = 0;
  let disposed = false;
  let phase: ViewerStatus["phase"] = "overview";
  let target: string | null = null;
  let lastError: string | null = null;
  let immersion: Immersion | null = null;
  let operation: AbortController | null = null;
  let transition: { lease: ViewerNavigationLease; flying: Flying | null } | null = null;
  let exiting: Promise<void> | null = null;
  let arrival: AbortController | null = null;
  let fading: { stop(): void } | null = null;
  let hovered: string | null = null;
  const mapHidden = new Set<string>();
  const onMap = (entry: Entry): boolean => entry.visible && !mapHidden.has(entry.input.id);
  let hoverRelease: (() => void) | null = null;
  let appearance = "";
  const listeners = new Set<(status: ViewerStatus) => void>();
  const frames = new Set<() => void>();
  const waitingSources = new Set<{ source: ViewerSource; entry: Entry; check(): void }>();
  const incomingSources = new Set<{ source: ViewerSource; entry: Entry }>();
  let warming: { entry: Entry; choice: ViewerSourceChoice; view: ViewerNavigationPresentation; source: ViewerSource | null; controller: AbortController; handoff: boolean } | null = null;
  const status = (): ViewerStatus => ({ phase, active: immersion?.entry.input.id ?? null, target,
    view: immersion?.look.get() ?? null, lastError, renderingAvailable: renderer.available,
    unavailableReason: renderer.unavailableReason,
    immersionDetail: immersion ? { ...immersion.shown.detail?.(), representation: immersion.shown.representation.id, loading: immersion.loading, limitation: immersion.limitation } : null,
    credits: immersion ? [{ ...immersion.entry.input.credits, assetId: immersion.entry.input.asset.id }] : [],
  });
  const emit = (): void => { const current = status(); for (const listener of [...listeners]) listener(current); };
  const sourceOf = (entry: Entry, source: ViewerSource): ImmersionSource => ({ ...source.source, content: entry.input.placement.content });
  const geoView = (look: LookState, roll: number): ViewerLook => ({ ...look, rollDeg: roll });
  const pose = (entry: Entry, view: ViewerLook): ViewerNavigationPresentation => options.poses.presentationFromView(entry.input, view);
  const duration = (): number => options.settings().look.reducedMotion ? 0 : options.settings().flightDurationMs;
  const fadeDuration = (): number => options.settings().look.reducedMotion ? options.settings().reducedFadeDurationMs : options.settings().fadeDurationMs;
  const beta = (): number => options.settings().appearance.previewFovDeg * Math.PI / 360;
  const live = (entry: Entry): boolean => !disposed && !entry.disposed && !entry.controller.signal.aborted;
  function stopWarming(entry?: Entry): void {
    const state = warming;
    if (!state || (entry && state.entry !== entry)) return;
    warming = null;
    try { state.controller.abort(new Error("Entry warming ended.")); }
    finally { state.source?.release(); }
  }
  function warmTiles(entry: Entry, view: ViewerLook): void {
    stopWarming();
    if (!renderer.available) return;
    const choice = resources.warm?.(entry.input, view);
    if (!choice || choice.representation.projection !== "tiled-cube") return;
    const state: NonNullable<typeof warming> = { entry, choice, view: pose(entry, view), source: null, controller: options.createAbortController(), handoff: false };
    warming = state;
    const work = Promise.resolve().then(() => resources.acquire(entry.input, choice, { signal: state.controller.signal, priority: 5, overlap: true })).then(source => {
      if (warming !== state || state.controller.signal.aborted || !live(entry) || source.isCurrent?.() === false) { source.release(); return; }
      state.source = source; options.requestRender();
    }, () => { if (warming === state) warming = null; });
    track(work);
    void work.catch(() => {});
  }
  function takeWarmed(entry: Entry, choice: ViewerSourceChoice): ViewerSource | null {
    const state = warming;
    if (!state || state.entry !== entry || !state.source || state.controller.signal.aborted || state.source.isCurrent?.() === false ||
        (state.choice.key ?? state.choice.representation.id) !== (choice.key ?? choice.representation.id)) return null;
    const source = state.source; state.source = null; warming = null;
    state.controller.abort(new Error("The immersive view took the warming hold."));
    return source;
  }
  function freeze(entry: Entry): void { entry.frozenPlacement = entry.input.placement; }
  function unfreeze(entry: Entry): void {
    entry.frozenPlacement = null;
    if (entry.pendingPlacement) { applyPlacement(entry, entry.pendingPlacement); entry.pendingPlacement = null; }
  }
  function applyPlacement(entry: Entry, placement: ViewerImageInput["placement"]): void {
    entry.input = { ...entry.input, placement };
    entry.orb.update({ marker: placement.marker, radiusMeters: placement.radiusMeters, content: placement.content, outline: placement.outline });
    if (immersion?.entry === entry && !immersion.leaving) renderer.immersion.replaceContent(placement.content);
    if (entry.visible) options.requestRender();
  }
  function withCapture(input: ViewerImageInput, capture: { latitudeDeg: number; longitudeDeg: number; heightMeters: number | null }): ViewerImageInput {
    const previous = input.details?.capture;
    return { ...input, details: { ...input.details, capture: {
      latitudeDeg: capture.latitudeDeg, longitudeDeg: capture.longitudeDeg, heightMeters: capture.heightMeters,
      horizontalAccuracyMeters: previous?.horizontalAccuracyMeters ?? null,
    } } };
  }
  function reposition(id: string, edit: { placement: ViewerImageInput["placement"]; capture?: { latitudeDeg: number; longitudeDeg: number; heightMeters: number | null } }): void {
    if (disposed) return;
    const entry = entries.get(id);
    if (!entry || !live(entry)) return;
    if (edit.capture) entry.input = withCapture(entry.input, edit.capture);
    const next = immutable(edit.placement);
    // A visit freezes ordinary ground updates. A placement edit still applies,
    // and replaces the frozen copy so leaving does not restore the old place.
    entry.pendingPlacement = null;
    if (entry.frozenPlacement) entry.frozenPlacement = next;
    applyPlacement(entry, next);
    const state = immersion;
    if (state?.entry === entry && !state.leaving && !state.lease.released && entry.input.details?.capture && next.marker) {
      state.lease.setPresentationView(pose(entry, geoView(state.look.get(), state.roll)));
    }
  }
  function setImageOpacity(id: string | null, opacity: number): void {
    if (disposed) return;
    const value = Math.min(1, Math.max(0, opacity));
    for (const entry of entries.values()) if (live(entry)) entry.orb.update({ opacity: id !== null && entry.input.id === id ? value : 1 });
    renderer.immersion.setOpacity(id === null ? 1 : value);
  }
  /** Steps `t` from 0 to 1 over `ms`, a frame at a time; a step that returns true ends it there. */
  function animate(ms: number, step: (t: number) => boolean | void, signal: AbortSignal, lease: ViewerNavigationLease | null): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!(ms > 0)) { step(1); return Promise.resolve(); }
    const release = lease ? lease.holdRendering() : options.holdRendering();
    const started = options.now();
    return track(new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (): void => { if (finished) return; finished = true; frames.delete(tick); signal.removeEventListener("abort", abort); release(); };
      const abort = (): void => { try { finish(); reject(signal.reason); } catch (error) { reject(new AggregateError([signal.reason, error], "Viewer animation cancellation failed.")); } };
      const tick = (): void => {
        if (signal.aborted) { abort(); return; }
        try { const t = Math.min(1, Math.max(0, (options.now() - started) / ms)); if (step(t) === true || t >= 1) { finish(); resolve(); } }
        catch (error) { finish(); reject(error); }
      };
      signal.addEventListener("abort", abort, { once: true }); frames.add(tick); options.requestRender();
    }));
  }
  function startOperation(signal?: ViewerAbortSignal): { controller: AbortController; stop(): void } {
    operation?.abort(new Error("Replaced by another navigation."));
    const controller = options.createAbortController(); operation = controller;
    const abort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    return { controller, stop() { signal?.removeEventListener("abort", abort); if (operation === controller) operation = null; } };
  }
  function report(entry: Entry, kind: "preview" | "navigation" | "image", error: unknown): void {
    lastError = message(error); options.failure?.(entry.input, kind, error); emit();
  }
  const previewCurrent = (entry: Entry): boolean => !!entry.preview && (entry.preview.isCurrent?.() ?? true);
  function loadPreview(entry: Entry, priority: number, diameter: number | null = null): Promise<void> {
    if (entry.loading) return entry.loading;
    const choice = resources.preview(entry.input, diameter);
    if (!choice) return Promise.reject(new Error("No preview fits the image budgets."));
    if (previewCurrent(entry) && (entry.preview?.key ?? entry.preview?.representation.id) === (choice.key ?? choice.representation.id) || entry.failedSharper === (choice.key ?? choice.representation.id)) return Promise.resolve();
    const controller = options.createAbortController(); entry.loadingController = controller;
    const abort = (): void => controller.abort(entry.controller.signal.reason);
    entry.controller.signal.addEventListener("abort", abort, { once: true });
    if (entry.controller.signal.aborted) abort();
    if (entry.preview && !previewCurrent(entry)) { entry.preview.release(); entry.preview = null; entry.orb.update({ texture: null }); if (entry.visible) options.requestRender(); }
    const old = entry.preview;
    const work = Promise.resolve().then(() => resources.acquire(entry.input, choice, { signal: controller.signal, priority, overlap: !!old })).then(source => {
      if (!live(entry) || controller.signal.aborted) {
        try { source.release(); } catch (error) { retirementFailure(error); }
        return;
      }
      entry.preview = source; entry.previewLimitation = choice.limitation; entry.previewError = null; entry.unneededSince = null;
      entry.orb.update({ texture: source.source.texture });
      // The immersive view can still hold the old preview while its orb sharpens.
      if (old && immersion?.shown !== old) old.release();
      if (immersion?.entry === entry && immersion.shown !== source) entry.pendingSettlements.add(source);
      else { settlePreviewReplacements(entry); source.settleReplacement(); }
      if (entry.visible) options.requestRender(); emit();
    }, error => {
      if (controller.signal.aborted || !live(entry)) throw controller.signal.reason ?? error;
      entry.previewError = error;
      if (old) entry.failedSharper = choice.key ?? choice.representation.id;
      report(entry, "preview", error); throw error;
    }).finally(() => {
      entry.controller.signal.removeEventListener("abort", abort);
      if (entry.loading === work) { entry.loading = null; entry.loadingController = null; }
    });
    entry.loading = work; return track(work);
  }
  async function ensurePreview(entry: Entry, signal: AbortSignal): Promise<ViewerSource> {
    signal.throwIfAborted();
    if (!previewCurrent(entry)) {
      const work = loadPreview(entry, 10);
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        void work.then(() => { signal.removeEventListener("abort", abort); resolve(); }, error => { signal.removeEventListener("abort", abort); reject(error); });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    if (!live(entry) || !previewCurrent(entry)) throw entry.previewError ?? new Error("The image preview is unavailable.");
    void loadPreview(entry, 10, Number.POSITIVE_INFINITY).catch(() => {});
    return entry.preview!;
  }
  function authoredView(entry: Entry, explicit?: LookState): LookState | undefined {
    return explicit ?? (options.settings().entryOrientation === "authored" ? entry.input.initialView : undefined);
  }
  function arrivalFor(entry: Entry, incoming: ViewerLook, explicit?: LookState): ViewerLook {
    const range = options.settings().look.fovRangeDeg;
    const authored = authoredView(entry, explicit);
    const fov = authored?.verticalFovDeg ?? options.settings().entryFovDeg ?? incoming.verticalFovDeg;
    return { ...(authored ?? incoming), rollDeg: 0, verticalFovDeg: Math.min(range.max, Math.max(range.min, fov)) };
  }
  function handBack(lease: ViewerNavigationLease, flying: Flying, moving: boolean, press: ViewerHeldPress | null, touches: readonly ViewerHeldTouch[] | null = null): void {
    const { flight, marker, t } = flying; const s = flightProgress(t); const current = flight.pose(s);
    let { velocity, turn } = moving ? flightMotion(flight, s, (flightProgressRate(t) * 1000) / flying.durationMs) : { velocity: [0, 0, 0] as Vec3, turn: [0, 0, 0] as Vec3 };
    const toMarker = sub(marker, current.position); const gap = length(toMarker) - flight.radius(s);
    const inward = dot(velocity, toMarker) / Math.max(1e-9, length(toMarker)); const keep = navigation.inertiaDecay();
    const travel = keep < 1 ? (inward / 60) / (1 - keep) : Number.POSITIVE_INFINITY;
    if (travel > 0 && travel > Math.max(0, gap)) { const share = Math.max(0, gap) / travel; velocity = scale(velocity, share); turn = scale(turn, share); }
    navigation.glide(lease, presented(current), marker, { velocity, turn, fovRad: lease.overview.camera.fov, inputSince: flying.startedMs, press, touches });
  }
  function stopFade(): void { fading?.stop(); fading = null; }
  function fadeOrb(entry: Entry, flying: Flying, done: () => void): void {
    stopFade(); const curve = options.world.glideSettling(navigation.inertiaDecay()); const controller = options.createAbortController();
    const s = flightProgress(flying.t); const revealed = flying.reveal(s); const from = flying.flight.radius(s); let finished = false;
    const finish = (): void => { if (finished) return; finished = true; if (fading === current) fading = null; if (live(entry)) { entry.orb.setExpansion(null); unfreeze(entry); } done(); };
    const current = { stop() { controller.abort(); finish(); } }; fading = current; freeze(entry);
    void animate(curve.durationMs, u => {
      if (!live(entry)) return; const settled = curve.settled(u * curve.durationMs); const own = entry.orb.effectiveRadius() ?? from;
      entry.orb.setExpansion({ radiusMeters: from + (own - from) * settled, reveal: revealed * (1 - settled), ...(flying.source ? { source: flying.source } : {}) });
    }, controller.signal, null).then(finish, finish);
  }
  function resetHover(): void {
    hovered = null; for (const entry of entries.values()) { entry.hover = 0; entry.orb.update({ displayScale: 1 }); }
    hoverRelease?.(); hoverRelease = null;
  }
  function settlePreviewReplacements(entry: Entry): void {
    const pending = [...entry.pendingSettlements];
    entry.pendingSettlements.clear();
    const errors: unknown[] = [];
    for (const source of pending) { try { source.settleReplacement(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Preview replacement settlement failed.");
  }
  function teardown(state: Immersion, releaseShown = true): ViewerSource | null {
    if (immersion !== state) return null; immersion = null;
    const owned = state.shown !== state.entry.preview ? state.shown : null;
    const pendingArrival = arrival; arrival = null;
    attempt([() => pendingArrival?.abort(), () => state.refine?.abort(), state.detach, state.stopLook, state.offAbort,
      () => renderer.immersion.show(null), () => { if (releaseShown) owned?.release(); },
      () => { if (releaseShown) settlePreviewReplacements(state.entry); },
      ...[...entries.values()].map(entry => () => unfreeze(entry))], "Viewer immersion cleanup failed.");
    return owned;
  }
  function startImmersion(entry: Entry, shown: ViewerSource, lease: ViewerNavigationLease, view: ViewerLook): Immersion {
    let state: Immersion | null = null; let release: (() => void) | null = null; let stepped = options.now();
    const look = createLookModel(view, () => options.settings().look, next => {
      if (!state || immersion !== state || state.leaving) return;
      lease.setPresentationView(pose(state.entry, geoView(next, state.roll))); emit();
    }, () => options.viewport?.() ?? null);
    const stopLook = (): void => { frames.delete(tick); release?.(); release = null; };
    const tick = (): void => { const now = options.now(); const moving = look.step(now - stepped); stepped = now; if (!moving) stopLook(); };
    const requestFrame = (): void => { options.requestRender(); if (!release && look.moving() && !lease.released) { stepped = options.now(); frames.add(tick); release = lease.holdRendering(); } };
    const input = options.input.attach({ model: look, lease, requestFrame, userInput() { arrival?.abort(); arrival = null; }, exit: () => { exit(); } });
    let attached = true;
    const abort = (): void => {
      if (state && immersion === state) { teardown(state); phase = "overview"; target = null; emit(); }
    };
    lease.signal.addEventListener("abort", abort, { once: true });
    state = { entry, shown, lease, look, roll: view.rollDeg, detach: () => { if (!attached) return; attached = false; input.detach(); }, stopLook,
      offAbort: () => lease.signal.removeEventListener("abort", abort), refine: null, refineWork: null, refinePhase: null, failed: new Set(), leaving: false, limitation: null, loading: null };
    return state;
  }
  /** Turns, levels and zooms the view to `to`: by default over the levelling time; `pace` continues a flight's own. */
  async function arrive(state: Immersion, to: ViewerLook, pace?: { durationMs: number; ease(t: number): number }): Promise<void> {
    const from = geoView(state.look.get(), state.roll); arrival?.abort(); const controller = options.createAbortController(); arrival = controller;
    const ease = pace?.ease ?? smooth;
    try { await animate(options.settings().look.reducedMotion ? 0 : pace?.durationMs ?? options.settings().orientDurationMs, t => {
      if (immersion !== state) return; const view = interpolateView(from, to, ease(t)); state.roll = view.rollDeg; state.look.set(view);
    }, controller.signal, state.lease); }
    catch { if (immersion === state && !state.leaving && state.roll !== 0) { state.roll = 0; state.look.set(state.look.get()); } }
    finally { if (arrival === controller) arrival = null; }
  }
  function face(next: Partial<LookState>): boolean {
    const state = immersion;
    if (!state || state.leaving || phase !== "immersive" || state.lease.released || state.lease.signal.aborted) return false;
    const current = state.look.get();
    const view = clampLook({
      headingDeg: next.headingDeg ?? current.headingDeg,
      pitchDeg: next.pitchDeg ?? current.pitchDeg,
      verticalFovDeg: next.verticalFovDeg ?? current.verticalFovDeg,
    }, options.settings().look);
    void arrive(state, { ...view, rollDeg: 0 }).catch(() => {});
    return true;
  }
  function awaitViewReady(source: ViewerSource, entry: Entry, signal: AbortSignal): Promise<void> {
    if (!source.viewReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const off = (): void => { waitingSources.delete(waiter); signal.removeEventListener("abort", abort); };
      const abort = (): void => { off(); reject(signal.reason); };
      const waiter = { source, entry, check() { if (signal.aborted) { abort(); return; } if (source.isCurrent?.() === false) { off(); reject(new Error("The incoming image generation ended.")); return; } if (source.viewReady!()) { off(); resolve(); } } };
      waitingSources.add(waiter); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      const camera = renderer.cameraFrame();
      if (camera) source.onFrame?.(camera, options.now(), entry.input.placement.content);
      waiter.check(); options.requestRender();
    });
  }
  function refine(state: Immersion): void {
    if (immersion !== state || state.leaving || state.refine || phase !== "immersive") return;
    const choice = resources.immersion(state.entry.input, state.look.get(), state.failed);
    if (!choice) return;
    if ((choice.key ?? choice.representation.id) === (state.shown.key ?? state.shown.representation.id)) { if (state.limitation !== choice.limitation) { state.limitation = choice.limitation; emit(); } return; }
    const entry = state.entry; state.loading = choice.representation.id; state.limitation = choice.limitation; emit();
    const controller = options.createAbortController(); state.refine = controller; state.refinePhase = "acquiring";
    if (warming?.entry === entry) warming.handoff = true;
    const current = (): boolean => immersion === state && state.entry === entry && state.refine === controller && !state.leaving && !controller.signal.aborted;
    const work = Promise.resolve().then(() => {
      try {
        controller.signal.throwIfAborted();
        // Transfer a ready hold, or join the existing pending cache source
        // before releasing the warming waiter. Neither path builds an atlas twice.
        return takeWarmed(entry, choice) ?? resources.acquire(entry.input, choice, { signal: controller.signal, priority: 10, overlap: true });
      } finally { stopWarming(entry); }
    }).then(async incoming => {
      if (!current() || incoming.isCurrent?.() === false) {
        try { incoming.release(); } catch (error) { retirementFailure(error); }
        return;
      }
      const old = state.shown, candidate = { source: incoming, entry }; incomingSources.add(candidate);
      let published = false;
      const discard = (): void => {
        const errors: unknown[] = [];
        for (const release of [() => { if (current() && phase === "immersive") renderer.immersion.show(state.shown.isCurrent?.() === false ? null : { source: sourceOf(state.entry, state.shown) }); }, () => incoming.release()]) {
          try { release(); } catch (error) { errors.push(error); }
        }
        if (errors.length) { retirementErrors.push(...errors); throw new AggregateError(errors, "Private image refinement cleanup failed."); }
      };
      try {
        if (incoming.source.kind === "tiles" && old.representation.role !== "preview") { state.refinePhase = "covering"; await awaitViewReady(incoming, entry, controller.signal); }
        if (!current() || incoming.isCurrent?.() === false) { discard(); return; }
        state.refinePhase = "fading";
        const ms = incoming.source.kind === "tiles" && old.representation.role === "preview" ? 0 : fadeDuration();
        await animate(ms, t => renderer.immersion.show({ source: sourceOf(state.entry, old), next: sourceOf(state.entry, incoming), mix: smooth(t) }), controller.signal, state.lease);
        if (!current() || incoming.isCurrent?.() === false) { discard(); return; }
        if (old.representation.role !== "preview" && incoming.viewReady && !incoming.viewReady()) await awaitViewReady(incoming, entry, controller.signal);
        if (!current() || incoming.isCurrent?.() === false) { discard(); return; }
        renderer.immersion.show({ source: sourceOf(state.entry, incoming) });
        state.shown = incoming; state.loading = null; published = true;
        const errors: unknown[] = [];
        for (const release of [() => { if (old !== state.entry.preview) old.release(); },
          () => settlePreviewReplacements(state.entry), () => incoming.settleReplacement(), emit]) {
          try { release(); } catch (error) { errors.push(error); }
        }
        if (errors.length) { retirementErrors.push(...errors); throw new AggregateError(errors, "Published image refinement cleanup failed."); }
      } catch (error) {
        let failure = error;
        if (!published) { try { discard(); } catch (release) { failure = new AggregateError([error, release], "Image refinement failed."); } }
        if (current()) report(entry, "image", failure);
      }
      finally { incomingSources.delete(candidate); }
    }, error => {
      if (current()) { state.failed.add(choice.representation.id); report(entry, "image", error); }
    }).finally(() => { const owns = state.refine === controller; if (owns) { const loading = state.loading; state.refine = null; state.refinePhase = null; state.loading = null; if (loading && immersion === state) emit(); } if (state.refineWork === work) state.refineWork = null; if (owns && immersion === state && state.entry === entry && phase === "immersive" && state.failed.has(choice.representation.id)) refine(state); });
    state.refineWork = work;
    track(work);
    void work.catch(() => {});
  }
  async function settleRefinement(state: Immersion): Promise<void> {
    const work = state.refineWork, hadFade = state.refinePhase === "fading";
    state.refine?.abort(new Error("A new navigation superseded refinement."));
    if (hadFade) {
      // Stop displaying the incoming texture before its cancelled fade releases it.
      if (immersion === state) renderer.immersion.show({ source: sourceOf(state.entry, state.shown) });
      await work;
    } else {
      // A late acquisition cannot publish after abort; it releases its own hold on arrival.
      state.refine = null; state.refineWork = null; state.refinePhase = null; state.loading = null;
    }
  }
  async function navigateWithin(entry: Entry, explicit: LookState | undefined, external: ViewerAbortSignal | undefined): Promise<boolean> {
    const state = immersion!; if (state.entry === entry && !explicit) return true;
    const op = startOperation(external); phase = "preparing"; target = entry.input.id; emit();
    try {
      const [first] = await Promise.all([ensurePreview(entry, op.controller.signal), settleRefinement(state)]);
      op.controller.signal.throwIfAborted();
      if (immersion !== state || operation !== op.controller || !live(entry) || !entry.visible || entries.get(entry.input.id) !== entry) throw new Error("Immersion ended.");
      phase = "entering"; emit();
      const view = geoView(explicit ?? state.look.get(), 0); const from = state.entry; const old = state.shown;
      await animate(fadeDuration(), t => renderer.immersion.show({ source: sourceOf(from, old), next: sourceOf(entry, entry.preview ?? first), mix: smooth(t), view: t < .5 ? pose(from, geoView(state.look.get(), state.roll)) : pose(entry, view) }), op.controller.signal, state.lease);
      op.controller.signal.throwIfAborted();
      if (immersion !== state || operation !== op.controller) throw new Error("Immersion ended.");
      if (!previewCurrent(entry)) throw new Error("The destination preview generation ended during navigation.");
      state.failed.clear(); state.loading = null; state.limitation = null; if (old !== from.preview) old.release();
      settlePreviewReplacements(from);
      unfreeze(from); freeze(entry); state.entry = entry; state.shown = entry.preview ?? first; state.roll = 0;
      renderer.immersion.show({ source: sourceOf(entry, state.shown) }); state.look.set(view); state.lease.setPresentationView(pose(entry, view));
      phase = "immersive"; target = null; emit(); refine(state); return true;
    } catch (error) {
      if (immersion === state && operation === op.controller) { renderer.immersion.show({ source: sourceOf(state.entry, state.shown) }); state.lease.setPresentationView(pose(state.entry, geoView(state.look.get(), state.roll))); phase = "immersive"; }
      if (operation === op.controller) { target = null; if (!op.controller.signal.aborted) report(entry, "navigation", error); emit(); } return false;
    } finally { op.stop(); }
  }
  async function enter(id: string, enterOptions: { signal?: ViewerAbortSignal; view?: LookState } = {}): Promise<boolean> {
    if (disposed || !renderer.available || !entries.has(id)) return false;
    if (exiting) { operation?.abort(new Error("Replaced by another navigation.")); await exiting; }
    const entry = entries.get(id); if (disposed || enterOptions.signal?.aborted || !entry || !entry.visible || !live(entry)) return false; stopFade();
    if (immersion) return navigateWithin(entry, enterOptions.view, enterOptions.signal);
    const op = startOperation(enterOptions.signal); const signal = op.controller.signal;
    phase = "preparing"; target = id; lastError = null; emit();
    let lease: ViewerNavigationLease | null = null; let flying: Flying | null = null;
    const input = options.input.cancelOnInput(op.controller);
    const endWithLease = (): void => op.controller.abort(new Error("Navigation ended."));
    try {
      const first = await ensurePreview(entry, signal); signal.throwIfAborted();
      if (!entry.visible || entries.get(id) !== entry) throw new Error("The image set changed.");
      const acquired = navigation.acquire(); if (!acquired.ok) throw new Error(acquired.message);
      lease = acquired.lease;
      if (lease.released || lease.signal.aborted) throw new Error("The navigation lease ended before entry."); transition = { lease, flying: null }; lease.signal.addEventListener("abort", endWithLease, { once: true });
      phase = "entering"; freeze(entry); emit();
      const frame = renderer.cameraFrame(); if (!frame) throw new Error("The host camera is not ready.");
      const start: FlightPose = { position: frame.eye, forward: frame.view.forward, up: frame.view.up, verticalFovRad: frame.view.verticalFovRad };
      let incoming = options.poses.viewFromPresentation(entry.input, presented(start));
      const marker = entry.input.placement.marker; const ms = marker ? duration() : 0; const radius = entry.orb.effectiveRadius(frame) ?? entry.input.placement.radiusMeters;
      // The flight widens or narrows to the field of view it arrives with, so entering is one motion with nothing left to zoom.
      const straight = marker && ms > 0 ? flightIn(options.world, start, marker, radius) : null;
      const landing = straight ? arrivalFor(entry, options.poses.viewFromPresentation(entry.input, presented(straight.pose(1))), enterOptions.view) : null;
      const flight = marker && landing ? flightIn(options.world, start, marker, radius, { verticalFovRad: landing.verticalFovDeg * Math.PI / 180, growth: options.settings().flightGrowth ?? FLIGHT_GROWTH }) : null;
      let settle: { durationMs: number; ease(t: number): number } | undefined;
      const expansion = !flight && marker && !options.settings().look.reducedMotion ? (() => {
        const rel = sub(marker, frame.eye); const distance = length(rel); const start = entry.orb.effectiveRadius(frame) ?? entry.input.placement.radiusMeters;
        if (distance <= start) return null; const end = expansionTargetRadius(distance, scale(rel, 1 / distance), frame.view, beta());
        return end === null ? null : { rel, start, end };
      })() : null;
      if (flight && marker && landing) {
        warmTiles(entry, landing);
        flying = { flight, marker, durationMs: ms, startedMs: options.now(), t: 0, reveal: s => Math.min(1, s / flight.surface) }; transition.flying = flying;
        // Inside the orb only the image shows, so the panorama takes over as soon as the eye is in and settles the rest of the way itself.
        await animate(ms, t => {
          flying!.t = t; const s = flightProgress(t); const at = flight.pose(s); const radius = flight.radius(s);
          navigation.place(lease!, presented(at), marker); entry.orb.setExpansion({ radiusMeters: radius, reveal: flying!.reveal(s) });
          return length(sub(marker, at.position)) < radius;
        }, signal, lease);
        const handed = flying.t; const s = flightProgress(handed); flying = null; transition.flying = null;
        const end = flight.pose(s); if (!handoffReady(orbGeometry(sub(marker, end.position), flight.radius(s)), poseView(end, frame.view.aspect), beta())) throw new Error("The flight did not end inside the orb.");
        if (handed < 1 && !authoredView(entry, enterOptions.view)) settle = { durationMs: (1 - handed) * ms, ease: u => (flightProgress(handed + u * (1 - handed)) - s) / (1 - s) };
        incoming = options.poses.viewFromPresentation(entry.input, presented(end));
        renderer.immersion.show({ source: sourceOf(entry, entry.preview ?? first) }); lease.setPresentationView(pose(entry, incoming)); entry.orb.setExpansion(null);
      } else if (expansion) {
        warmTiles(entry, arrivalFor(entry, incoming, enterOptions.view));
        await animate(options.settings().expandDurationMs, t => { const eased = smooth(t); entry.orb.setExpansion({ radiusMeters: expansion.start + (expansion.end - expansion.start) * eased, reveal: eased }); }, signal, lease);
        if (!handoffReady(orbGeometry(expansion.rel, expansion.end), frame.view, beta())) throw new Error("The expanded orb did not cover the view.");
        renderer.immersion.show({ source: sourceOf(entry, entry.preview ?? first) }); lease.setPresentationView(pose(entry, incoming)); entry.orb.setExpansion(null);
      } else {
        const view = arrivalFor(entry, incoming, enterOptions.view); const destination = pose(entry, view);
        warmTiles(entry, view);
        await animate(fadeDuration(), t => renderer.immersion.show({ source: sourceOf(entry, entry.preview ?? first), opacity: smooth(t), view: destination }), signal, lease);
        renderer.immersion.show({ source: sourceOf(entry, entry.preview ?? first) }); lease.setPresentationView(destination); incoming = view;
      }
      signal.throwIfAborted(); if (!previewCurrent(entry)) throw new Error("The image preview generation ended during entry."); input.stop();
      const state = startImmersion(entry, entry.preview ?? first, lease, incoming); immersion = state; transition = null;
      phase = "immersive"; target = null; resetHover(); emit(); refine(state); void arrive(state, flight && landing ? landing : arrivalFor(entry, incoming, enterOptions.view), settle); return true;
    } catch (error) {
      const replaced = operation !== op.controller || !entry.visible;
      if (lease && !lease.released && !immersion) {
        renderer.immersion.show(null);
        if (flying && !disposed) { handBack(lease, flying, true, input.press(), input.touches?.() ?? null); if (!replaced) fadeOrb(entry, flying, () => {}); }
        else navigation.restore(lease.overview, lease);
        lease.release("cancelled");
      }
      if (!flying || replaced) { entry.orb.setExpansion(null); unfreeze(entry); }
      if (!replaced && !disposed && !immersion) { phase = "overview"; target = null; }
      if (!replaced && !signal.aborted) report(entry, "navigation", error); if (!replaced) emit(); return false;
    } finally { input.stop(); if (!warming?.handoff || warming.entry !== entry) stopWarming(entry); lease?.signal.removeEventListener("abort", endWithLease); if (transition?.lease === lease) transition = null; op.stop(); }
  }
  async function leave(state: Immersion): Promise<void> {
    const op = startOperation(); phase = "exiting"; state.leaving = true; arrival?.abort(); state.detach(); state.stopLook(); emit();
    await settleRefinement(state);
    if (immersion !== state || op.controller.signal.aborted) { op.stop(); return; }
    const entry = state.entry; const view = pose(entry, geoView(state.look.get(), state.roll)); const source = sourceOf(entry, state.shown);
    const marker = entry.input.placement.marker; const frame = renderer.cameraFrame(view); const ms = duration();
    const overview = state.lease.overview.camera;
    const ownRadius = frame ? Math.max(options.settings().appearance.markerDiameterCssPx.min * overview.radius * Math.tan(overview.fov / 2) / frame.viewportHeightCssPx,
      Math.min(options.settings().appearance.markerDiameterCssPx.max * overview.radius * Math.tan(overview.fov / 2) / frame.viewportHeightCssPx, entry.input.placement.radiusMeters)) : entry.input.placement.radiusMeters;
    const candidate = marker && frame && ms > 0 ? flightOut(options.world, { forward: [view.forward.x, view.forward.y, view.forward.z], up: [view.up.x, view.up.y, view.up.z], verticalFovRad: view.verticalFovRad }, marker, ownRadius, overview, { growth: options.settings().flightGrowth ?? FLIGHT_GROWTH }) : null;
    const flight = candidate && marker && frame && handoffReady(orbGeometry(sub(marker, candidate.pose(0).position), candidate.radius(0)), poseView(candidate.pose(0), frame.view.aspect), beta()) ? candidate : null;
    const flying: Flying | null = flight && marker ? { flight, marker, durationMs: ms, startedMs: options.now(), t: 0, reveal: s => Math.min(1, (1 - s) / (1 - flight.surface)), source } : null;
    const input = options.input.cancelOnInput(op.controller); let cut = false;
    const abort = (): void => op.controller.abort(new Error("Navigation ended.")); state.lease.signal.addEventListener("abort", abort, { once: true });
    transition = { lease: state.lease, flying };
    try {
      if (flight && flying && marker) {
        navigation.place(state.lease, presented(flight.pose(0)), marker); entry.orb.setExpansion({ radiusMeters: flight.radius(0), reveal: 1, source }); state.lease.setPresentationView(null); renderer.immersion.show(null);
        await animate(ms, t => { flying.t = t; const s = flightProgress(t); navigation.place(state.lease, presented(flight.pose(s)), marker); entry.orb.setExpansion({ radiusMeters: flight.radius(s), reveal: flying.reveal(s), source }); }, op.controller.signal, state.lease);
      } else {
        navigation.restore(state.lease.overview, state.lease); state.lease.setPresentationView(null);
        await animate(fadeDuration(), t => renderer.immersion.show({ source, opacity: 1 - smooth(t), view }), op.controller.signal, state.lease);
      }
    } catch { cut = true; }
    finally { input.stop(); state.lease.signal.removeEventListener("abort", abort); if (transition?.lease === state.lease) transition = null; }
    if (immersion !== state) { op.stop(); return; }
    const handed = !!flying && cut && !disposed && !state.lease.released;
    if (flying && handed) handBack(state.lease, flying, true, input.press(), input.touches?.() ?? null);
    else { entry.orb.setExpansion(null); if (flight) navigation.restore(flight.end, state.lease); }
    const shown = teardown(state, !handed); state.lease.release("exit");
    if (flying && handed) fadeOrb(entry, flying, () => { shown?.release(); settlePreviewReplacements(entry); });
    phase = "overview"; target = null; navigation.returnFocus(state.lease); op.stop(); emit();
  }
  function exit(): void {
    if (disposed) return; if (!immersion) { operation?.abort(new Error("Cancelled.")); return; }
    if (exiting) return;
    const leaving = immersion;
    const work = leave(leaving).catch(error => { report(leaving.entry, "navigation", error); clearNavigation(); emit(); }).finally(() => { if (exiting === work) exiting = null; }); exiting = work; track(work);
  }
  function clearNavigation(): void {
    const active = immersion;
    attempt([
      stopWarming, () => { operation?.abort(new Error("The image set changed.")); operation = null; }, stopFade, resetHover,
      () => { if (active) active.entry.orb.setExpansion(null); }, () => { if (active) teardown(active); },
      () => {
        const current = transition;
        if (!current || current.lease.released) return;
        attempt([() => { if (current.flying) handBack(current.lease, current.flying, true, null);
          else navigation.restore(current.lease.overview, current.lease); },
          () => current.lease.release("cancelled"), () => { transition = null; }], "Viewer transition cleanup failed.");
      },
      () => { if (active && !active.lease.released) attempt([
        () => navigation.restore(active.lease.overview, active.lease), () => active.lease.release("cancelled"),
      ], "Viewer navigation cleanup failed."); },
      () => { phase = disposed ? "disposed" : "overview"; target = null; },
    ], "Viewer navigation retirement failed.");
  }
  function disposeEntry(entry: Entry): void {
    if (entry.disposed) return;
    const navigates = immersion?.entry === entry || (entry.visible && target === entry.input.id);
    entry.disposed = true;
    attempt([() => stopWarming(entry), () => { if (navigates) clearNavigation(); }, entry.offExternal,
      () => entry.controller.abort(new Error("The image was disposed.")), () => entry.loadingController?.abort(),
      () => entry.orb.setExpansion(null), () => { const source = entry.preview; entry.preview = null; source?.release(); },
      () => settlePreviewReplacements(entry), () => entry.orb.dispose(), () => prepared.delete(entry),
      () => { if (entries.get(entry.input.id) === entry) entries.delete(entry.input.id); },
    ], "Viewer prepared-image cleanup failed.");
  }
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    attempt([clearNavigation, ...[...prepared].map(entry => () => disposeEntry(entry)),
      () => entries.clear(), () => frames.clear(), emit, () => listeners.clear(),
      () => options.signal?.removeEventListener("abort", aborted)], "Viewer disposal failed.");
  };
  const aborted = (): void => { try { dispose(); } catch (error) { retirementFailure(error); } };
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  return {
    async prepare(input, external) {
      if (disposed) throw new Error("The image viewer is disposed.");
      if (external.aborted) throw external.reason;
      input = snapshotInput(input);
      const controller = options.createAbortController(); const drawId = `viewer-${++serial}:${input.id}`;
      const orb = renderer.addOrb(drawId, { ...input.placement, texture: null, visible: false, displayScale: 1 });
      const entry: Entry = { input, drawId, orb, controller, visible: false, disposed: false, preview: null, previewLimitation: null, loading: null, loadingController: null, previewError: null, failedSharper: null, unneededSince: null, frozenPlacement: null, pendingPlacement: null, hover: 0, offExternal: () => external.removeEventListener("abort", abort), pendingSettlements: new Set() };
      prepared.add(entry); const abort = (): void => { try { disposeEntry(entry); } catch (error) { retirementFailure(error); } }; external.addEventListener("abort", abort, { once: true });
      const handle: PreparedViewerImage = { id: input.id,
        ready: async () => { if (!live(entry)) throw new Error("The image was disposed."); if (!renderer.available) throw new Error(renderer.unavailableReason ?? "Images cannot be drawn here."); if (!previewCurrent(entry)) await loadPreview(entry, 1); if (!live(entry) || !previewCurrent(entry)) throw entry.previewError ?? new Error("The image preview is unavailable."); },
        updatePlacement(placement) { if (!live(entry)) return; const next = immutable(placement); if (entry.frozenPlacement) entry.pendingPlacement = next; else applyPlacement(entry, next); },
        hover(active) { if (entry.visible) { hovered = active ? input.id : hovered === input.id ? null : hovered; options.requestRender(); } },
        dispose() { external.removeEventListener("abort", abort); disposeEntry(entry); },
      };
      handles.set(handle, entry); if (external.aborted) { handle.dispose(); throw external.reason; } return handle;
    },
    setMapVisibility(hiddenIds) {
      if (disposed) return;
      mapHidden.clear();
      for (const id of hiddenIds) mapHidden.add(id);
      if (hovered && mapHidden.has(hovered)) { hovered = null; hoverRelease?.(); hoverRelease = null; }
      for (const entry of entries.values()) if (live(entry)) entry.orb.update({ visible: onMap(entry) });
      options.requestRender(); emit();
    },
    replaceImages(images) {
      if (disposed) throw new Error("The image viewer is disposed.");
      const next = new Map<string, Entry>();
      for (const image of images) { const entry = handles.get(image); if (!entry || image.id !== entry.input.id || !live(entry) || next.has(image.id)) throw new Error("Invalid, disposed or duplicate prepared image."); next.set(image.id, entry); }
      // Validate everything before changing the previous published set.
      clearNavigation(); for (const entry of entries.values()) { entry.orb.setExpansion(null); entry.visible = false; entry.orb.update({ visible: false }); }
      entries = next;
      for (const entry of entries.values()) { entry.visible = true; entry.orb.update({ visible: onMap(entry) }); if (renderer.available) void loadPreview(entry, 1).catch(() => {}); }
      options.requestRender(); emit();
    },
    enter: (...args) => track(enter(...args)), exit, face, status, describeImage(id) { return entries.get(id)?.input ?? null; },
    isPlacementFrozen(id) {
      const entry = entries.get(id);
      return !!entry && entry.visible && live(entry) && entry.frozenPlacement !== null;
    },
    currentSources(id) {
      const entry = entries.get(id);
      if (!entry || !entry.visible || !live(entry)) return { preview: null, shown: null };
      return {
        preview: previewCurrent(entry) ? entry.preview!.representation.id : null,
        shown: immersion?.entry === entry && !immersion.lease.released && !immersion.lease.signal.aborted && immersion.shown.isCurrent?.() !== false ? immersion.shown.representation.id : null,
      };
    },
    describeResources(id) {
      const entry = entries.get(id);
      if (!entry || !entry.visible || !live(entry) || !previewCurrent(entry)) return { previewDetail: null };
      return { previewDetail: { representation: entry.preview!.representation.id, faceTexels: resources.faceTexels(entry.preview!.representation), limitation: entry.previewLimitation } };
    },
    subscribe(listener) { if (!disposed) { listeners.add(listener); listener(status()); } return () => { listeners.delete(listener); }; },
    pick(x, y) { if (disposed || phase !== "overview") return []; const ids = new Map([...entries.values()].filter(onMap).map(entry => [entry.drawId, entry.input.id])); return renderer.pick(x, y, options.isOccluded).flatMap(hit => ids.has(hit.id) ? [ids.get(hit.id)!] : []); },
    pickRay(origin, direction) { if (disposed || phase !== "overview") return []; const ids = new Map([...entries.values()].filter(onMap).map(entry => [entry.drawId, entry.input.id])); return (renderer.pickRay?.([...origin], [...direction], options.isOccluded) ?? []).flatMap(hit => ids.has(hit.id) ? [ids.get(hit.id)!] : []); },
    hover(id) { const next = phase === "overview" && id && entries.has(id) && !mapHidden.has(id) ? id : null; if (next === hovered) return; hovered = next; if (!hoverRelease) hoverRelease = options.holdRendering(); options.requestRender(); emit(); },
    reposition, setImageOpacity,
    updateActions(id, actions) {
      const entry = entries.get(id);
      if (disposed || !entry || !live(entry)) return;
      entry.input = { ...entry.input, actions: snapshotActions(actions) };
      emit(); options.requestRender();
    },
    async activateAction(id) { const action = immersion?.entry.input.actions.find(item => item.id === id); return action ? await action.activate() : false; },
    onFrame(frame) {
      if (disposed) return false;
      if (immersion?.shown.isCurrent?.() === false) { clearNavigation(); emit(); }
      for (const entry of entries.values()) if (onMap(entry) && entry.preview?.isCurrent?.() === false && !entry.loading) void loadPreview(entry, 1).catch(() => {});
      for (const tick of [...frames]) tick();
      const settings = options.settings();
      const nextAppearance = `${settings.appearance.previewFovDeg}/${settings.appearance.markerDiameterCssPx.min}/${settings.appearance.markerDiameterCssPx.max}/${settings.appearance.hitTargetDiameterCssPx}`;
      if (nextAppearance !== appearance) { appearance = nextAppearance; renderer.setAppearance(settings.appearance); }
      let hovering = false;
      for (const entry of entries.values()) {
        const goal = phase === "overview" && entry.input.id === hovered ? 1 : 0;
        const duration = settings.look.reducedMotion ? 0 : settings.hoverDurationMs;
        const change = duration > 0 ? Math.max(0, frame.dtMs) / duration : 1;
        const next = goal > entry.hover ? Math.min(goal, entry.hover + change) : Math.max(goal, entry.hover - change);
        if (next !== entry.hover) { entry.hover = next; entry.orb.update({ displayScale: 1 + (entry.input.placement.hoverScale - 1) * smooth(next) }); }
        hovering ||= next !== goal;
      }
      if (!hovering) { hoverRelease?.(); hoverRelease = null; }
      const camera = renderer.cameraFrame();
      const warm = warming;
      if (warm?.source) {
        if (!live(warm.entry) || warm.source.isCurrent?.() === false) stopWarming(warm.entry);
        else {
          const targetFrame = renderer.cameraFrame(warm.view);
          if (targetFrame && warm.source.onFrame?.(targetFrame, frame.now, warm.entry.input.placement.content)) options.requestRender();
        }
      }
      if (camera && !immersion && phase === "overview") {
        const candidates = [...entries.values()].filter(onMap).map(entry => {
          const marker = entry.input.placement.marker; const radius = entry.orb.effectiveRadius(camera);
          const rel = marker ? sub(marker, camera.eye) : null;
          const diameter = rel && radius !== null && onScreen(rel, camera) ? radius * camera.viewportHeightCssPx / (Math.max(length(rel), radius) * Math.tan(camera.view.verticalFovRad / 2)) * options.devicePixelsPerCss() : null;
          return { entry, diameter };
        }).sort((a, b) => (b.diameter ?? 0) - (a.diameter ?? 0));
        for (const { entry, diameter } of candidates) {
          if (!entry.preview || entry.loading) continue;
          const choice = resources.preview(entry.input, diameter); if (!choice) continue;
          const shown = resources.faceTexels(entry.preview.representation); const wanted = resources.faceTexels(choice.representation);
          if (wanted > shown && diameter !== null) { entry.unneededSince = null; void loadPreview(entry, Math.min(.99, diameter / Math.max(1, settings.appearance.markerDiameterCssPx.max * options.devicePixelsPerCss())), diameter).catch(() => {}); }
          else if (wanted < shown && settings.previewHoldMs !== null) { entry.unneededSince ??= frame.now; if (frame.now - entry.unneededSince >= settings.previewHoldMs) void loadPreview(entry, 0, diameter).catch(() => { entry.unneededSince = frame.now; }); }
          else entry.unneededSince = null;
        }
      }
      if (camera) { for (const incoming of [...incomingSources]) if (incoming.source.onFrame?.(camera, frame.now, incoming.entry.input.placement.content)) options.requestRender(); for (const waiting of [...waitingSources]) waiting.check(); }
      if (camera && immersion && !immersion.leaving) { const before = JSON.stringify(immersion.shown.detail?.()); if (immersion.shown.onFrame?.(camera, frame.now, immersion.entry.input.placement.content)) options.requestRender(); if (JSON.stringify(immersion.shown.detail?.()) !== before) emit(); refine(immersion); }
      return frames.size > 0 || hovering;
    },
    dispose,
    async whenSettled() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      const results = await Promise.allSettled([options.resources.whenSettled?.()]);
      for (const result of results) if (result.status === "rejected") retirementErrors.push(result.reason);
      if (retirementErrors.length) throw new AggregateError(retirementErrors, "Viewer retirement failed.");
    },
  };
}
