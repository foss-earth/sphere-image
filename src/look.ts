/** Retained sphere look model, ticked by the host frame only. */
import type { ImageCameraAnchor, TouchPair } from "./cameraTarget.js";
import { anchorSphereCamera, projectSphereRay, sphereRay, type SpherePoint, type SpherePoseLimits, type SphereViewport } from "./sphereCamera.js";
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const FRAME_MS = 1000 / 60;
const FRAME_S = FRAME_MS / 1000;
export interface LookState {
  headingDeg: number;
  pitchDeg: number;
  verticalFovDeg: number;
}

export interface LookSettings {
  /** Direct image contact by default; `scroll` turns by relative XY movement without an anchor. */
  dragMode?: "grab" | "scroll";
  /** deg per CSS px without a measured viewport: `scene.panorama.dragSensitivity`. */
  dragSensitivity: number;
  /** deg per CSS px of a trackpad swipe at 90° FOV, scaled with tan(fov/2): `scene.panorama.swipeSensitivity`. */
  swipeSensitivity: number;
  /** deg/s for keys and a full stick: `lookRate`. */
  lookRate: number;
  /** log-tan-FOV per wheel notch and per second: `zoomPerNotch`, `zoomRate`. */
  zoomPerNotch: number;
  zoomRate: number;
  pinchGain: number;
  /** ms; 0 turns inertia off: `inertiaHalfLife`. */
  inertiaHalfLifeMs: number;
  fovRangeDeg: { min: number; max: number };
  pitchRangeDeg: { min: number; max: number };
  reducedMotion: boolean;
}

/** Below this angular speed, deg/s at 90° FOV, inertia has stopped. */
const INERTIA_STOP_DEG_PER_S = 0.02;
/** Below this log-tan-FOV speed, per second, zoom inertia has stopped. */
const INERTIA_STOP_ZOOM_PER_S = 0.0004;
const MAX_INERTIA_DEG_PER_S = 12 * 60;
const MAX_INERTIA_ZOOM_PER_S = 0.14 * 60;
/** A drag held still this long, ms, before its release has no glide. */
const GLIDE_RELEASE_WINDOW_MS = 80;
const WHEEL_NOTCH_PX = 100;

export function clampLook(state: LookState, settings: LookSettings): LookState {
  return {
    headingDeg: ((state.headingDeg % 360) + 360) % 360,
    pitchDeg: Math.min(settings.pitchRangeDeg.max, Math.max(settings.pitchRangeDeg.min, state.pitchDeg)),
    verticalFovDeg: Math.min(settings.fovRangeDeg.max, Math.max(settings.fovRangeDeg.min, state.verticalFovDeg)),
  };
}

/** Multiplies tan(fov/2) by exp(−amount): positive amounts narrow the view. */
export function zoomFov(fovDeg: number, amount: number): number {
  return 2 * Math.atan(Math.tan((fovDeg * DEG_TO_RAD) / 2) * Math.exp(-amount)) * RAD_TO_DEG;
}

/** Scales a swipe's angular turn with tan(fov/2), unity at 90° FOV, so apparent screen speed matches the zoom level. */
export function swipeFovScale(fovDeg: number): number {
  return Math.tan((fovDeg * DEG_TO_RAD) / 2);
}

function clampSpeed(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

export interface LookModel {
  get(): LookState;
  set(state: LookState): void;
  /** The current gesture's actual image point, projected into the measured view. */
  anchor(): ImageCameraAnchor | null;
  subscribeAnchors(changed: () => void): () => void;
  /** A drag from `from` by (dx, dy) CSS px over `dtMs`. Its speed glides on only after the release. */
  drag(dx: number, dy: number, dtMs: number, from?: SpherePoint | null): void;
  /** The drag ends, `stillMs` after its last move: a drag held still before the release has no glide. */
  release(stillMs?: number): void;
  /** Wheel deltaY in CSS px; negative (wheel up) narrows. `at` anchors the ray there. */
  wheel(deltaPx: number, at?: SpherePoint | null): void;
  /** A trackpad swipe's scroll deltas, CSS px, already in the direction the person chose. */
  swipe(deltaX: number, deltaY: number): void;
  /** Zooms by a pinch's scale change as a natural logarithm; positive (fingers apart) narrows. `at` anchors the ray there. */
  pinchBy(logScale: number, at?: SpherePoint | null): void;
  /** Pinch from one finger separation to another. */
  pinch(fromPx: number, toPx: number): void;
  /** Two touches moved: separation and midpoint motion are one anchored update when the view is measured. */
  touchPinch(from: TouchPair, to: TouchPair, dtMs?: number): void;
  /** Held rates: look right/up and zoom in, each −1 to 1. */
  setRates(rates: { lookX: number; lookY: number; zoom: number }): void;
  /** Advances held rates and inertia; returns whether anything is still moving. */
  step(dtMs: number): boolean;
  moving(): boolean;
  cancelInertia(): void;
}

export function createLookModel(initial: LookState, settings: () => LookSettings, onChange: (state: LookState) => void, viewport?: () => SphereViewport | null): LookModel {
  let state = clampLook(initial, settings());
  let grab: { kind: "drag" | "pinch" | "zoom"; ray: ReturnType<typeof sphereRay>; at: SpherePoint; width: number; height: number } | null = null;
  let marker: { ray: ReturnType<typeof sphereRay>; grab: boolean; zoom: boolean; held: boolean } | null = null;
  const anchorListeners = new Set<() => void>();
  const notifyAnchors = (): void => { for (const listener of anchorListeners) listener(); };
  const readViewport = (): SphereViewport | null => {
    const view = viewport?.() ?? null;
    return view && view.width > 0 && view.height > 0 ? view : null;
  };
  const limitsOf = (current: LookSettings): SpherePoseLimits => ({ fovDeg: current.fovRangeDeg, pitchDeg: current.pitchRangeDeg });
  const frameDecay = (current: LookSettings): number =>
    current.reducedMotion || current.inertiaHalfLifeMs <= 0 ? 0 : Math.pow(0.5, FRAME_MS / current.inertiaHalfLifeMs);
  /** Zoom by `amount` on tan(fov/2). A measured view keeps the ray under `at` on the way to `to`. */
  const anchored = (next: LookState, amount: number, at: SpherePoint | null, to: SpherePoint | null, kind?: "drag" | "pinch" | "zoom"): LookState => {
    const requested = amount === 0 ? next.verticalFovDeg : zoomFov(next.verticalFovDeg, amount);
    const view = readViewport();
    if (!view) { grab = null; marker = null; return { ...next, verticalFovDeg: requested }; }
    const from = at ?? { x: view.width / 2, y: view.height / 2 };
    const holds = kind !== undefined;
    const retained = holds && grab?.kind === kind && grab.at.x === from.x && grab.at.y === from.y && grab.width === view.width && grab.height === view.height ? grab : null;
    const ray = retained?.ray ?? sphereRay(next, view, from);
    // At a pitch limit the finger can travel beyond the grabbed point. Start
    // the solver at that point's actual projection and keep holding its ray.
    const source = retained ? projectSphereRay(next, view, ray) ?? from : from;
    const destination = to ?? from;
    grab = holds ? { kind, ray, at: destination, width: view.width, height: view.height } : null;
    marker = { ray, grab: kind === "drag" || kind === "pinch", zoom: kind !== "drag", held: true };
    return anchorSphereCamera(next, view, ray, destination, requested, limitsOf(settings()), source);
  };
  let velocity = { heading: 0, pitch: 0, zoom: 0 };
  let rates = { lookX: 0, lookY: 0, zoom: 0 };
  // While a drag holds the image, its speed is kept for the release, not applied.
  let held = false;
  const apply = (next: LookState): void => {
    state = clampLook(next, settings());
    onChange(state);
    notifyAnchors();
  };
  const zoomImpulse = (amount: number, at: SpherePoint | null): void => {
    if (!Number.isFinite(amount) || amount === 0) return;
    const current = settings();
    const d = frameDecay(current);
    const immediate = (1 - d) * amount;
    const baseZoom = held ? 0 : velocity.zoom;
    held = false;
    velocity = {
      heading: 0,
      pitch: 0,
      zoom: d > 0 ? clampSpeed(baseZoom + (d * immediate) / FRAME_S, MAX_INERTIA_ZOOM_PER_S) : 0,
    };
    const next = anchored(state, immediate, at, null, "zoom");
    apply(next);
    if ((state.verticalFovDeg <= current.fovRangeDeg.min && velocity.zoom > 0) || (state.verticalFovDeg >= current.fovRangeDeg.max && velocity.zoom < 0)) {
      velocity = { ...velocity, zoom: 0 };
      if (grab?.kind === "zoom") grab = null;
    }
  };
  return {
    get: () => state,
    anchor() {
      const view = readViewport();
      const point = marker && view ? projectSphereRay(state, view, marker.ray) : null;
      return point && marker ? { ...point, grab: marker.grab, zoom: marker.zoom, held: marker.held } : null;
    },
    subscribeAnchors(changed) {
      anchorListeners.add(changed);
      return () => { anchorListeners.delete(changed); };
    },
    set(next) {
      velocity = { heading: 0, pitch: 0, zoom: 0 };
      grab = null;
      marker = null;
      apply(next);
    },
    drag(dx, dy, dtMs, from) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const view = readViewport();
      const current = settings();
      let next: LookState;
      let heading: number, pitch: number;
      if (current.dragMode === "scroll") {
        grab = null;
        marker = null;
        const gain = view ? 2 * swipeFovScale(state.verticalFovDeg) / view.height * RAD_TO_DEG : current.dragSensitivity;
        heading = -dx * gain;
        next = clampLook({ ...state, headingDeg: state.headingDeg + heading, pitchDeg: state.pitchDeg + dy * gain }, current);
        pitch = next.pitchDeg - state.pitchDeg;
      } else if (view) {
        const at = from ?? { x: view.width / 2, y: view.height / 2 };
        next = anchored(state, 0, at, { x: at.x + dx, y: at.y + dy }, "drag");
        heading = ((next.headingDeg - state.headingDeg + 540) % 360) - 180;
        pitch = next.pitchDeg - state.pitchDeg;
      } else {
        grab = null;
        marker = null;
        const gain = settings().dragSensitivity;
        heading = -dx * gain;
        pitch = dy * gain;
        next = { ...state, headingDeg: state.headingDeg + heading, pitchDeg: state.pitchDeg + pitch };
      }
      held = true;
      if (dtMs > 0) velocity = { heading: (heading / dtMs) * 1000, pitch: (pitch / dtMs) * 1000, zoom: 0 };
      apply(next);
    },
    release(stillMs = 0) {
      held = false;
      grab = null;
      const current = settings();
      if (current.reducedMotion || current.inertiaHalfLifeMs <= 0 || stillMs > GLIDE_RELEASE_WINDOW_MS) velocity = { heading: 0, pitch: 0, zoom: 0 };
      if (marker) marker = velocity.heading || velocity.pitch || velocity.zoom ? { ...marker, held: false } : null;
      notifyAnchors();
    },
    wheel(deltaPx, at) {
      zoomImpulse((-deltaPx / WHEEL_NOTCH_PX) * settings().zoomPerNotch, at ?? null);
    },
    swipe(deltaX, deltaY) {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
      const current = settings();
      const fovScale = swipeFovScale(state.verticalFovDeg);
      const gain = current.swipeSensitivity * fovScale;
      const heading = deltaX * gain;
      const pitch = -deltaY * gain;
      const d = frameDecay(current);
      const immediateHeading = (1 - d) * heading;
      const immediatePitch = (1 - d) * pitch;
      const maxDegPerS = MAX_INERTIA_DEG_PER_S * Math.max(fovScale, 0.05);
      const baseHeading = held ? 0 : velocity.heading;
      const basePitch = held ? 0 : velocity.pitch;
      held = false;
      grab = null;
      marker = null;
      velocity = d > 0 ? {
        heading: clampSpeed(baseHeading + (d * immediateHeading) / FRAME_S, maxDegPerS),
        pitch: clampSpeed(basePitch + (d * immediatePitch) / FRAME_S, maxDegPerS),
        zoom: 0,
      } : { heading: 0, pitch: 0, zoom: 0 };
      apply({ ...state, headingDeg: state.headingDeg + immediateHeading, pitchDeg: state.pitchDeg + immediatePitch });
      if ((state.pitchDeg >= current.pitchRangeDeg.max && velocity.pitch > 0) || (state.pitchDeg <= current.pitchRangeDeg.min && velocity.pitch < 0)) {
        velocity = { ...velocity, pitch: 0 };
      }
    },
    pinch(fromPx, toPx) {
      if (!(fromPx > 0 && toPx > 0)) return;
      this.pinchBy(Math.log(toPx / fromPx));
    },
    touchPinch(from, to, dtMs) {
      if (!(from.separation > 0 && to.separation > 0)) return;
      held = true;
      const zoomAmount = Math.log(to.separation / from.separation) * settings().pinchGain;
      const next = anchored(state, zoomAmount, from.mid, to.mid, "pinch");
      if (dtMs && dtMs > 0) {
        const heading = ((next.headingDeg - state.headingDeg + 540) % 360) - 180;
        const pitch = next.pitchDeg - state.pitchDeg;
        velocity = { heading: (heading / dtMs) * 1000, pitch: (pitch / dtMs) * 1000, zoom: (zoomAmount / dtMs) * 1000 };
      } else {
        velocity = { heading: 0, pitch: 0, zoom: 0 };
      }
      apply(next);
    },
    pinchBy(logScale, at) {
      if (!Number.isFinite(logScale)) return;
      zoomImpulse(logScale * settings().pinchGain, at ?? null);
    },
    setRates(next) {
      rates = next;
      if (next.lookX || next.lookY || next.zoom) grab = null;
      if (next.lookX || next.lookY) velocity = { ...velocity, heading: 0, pitch: 0 };
      if (next.zoom) velocity = { ...velocity, zoom: 0 };
      if (next.lookX || next.lookY) { marker = null; notifyAnchors(); }
    },
    step(dtMs) {
      const current = settings();
      const dt = Math.max(0, Math.min(dtMs, 100)) / 1000;
      let next = state;
      if (rates.lookX || rates.lookY) {
        next = {
          ...next,
          headingDeg: next.headingDeg + rates.lookX * current.lookRate * dt,
          pitchDeg: next.pitchDeg + rates.lookY * current.lookRate * dt,
        };
      }
      if (!held && (velocity.heading || velocity.pitch || velocity.zoom)) {
        if (current.reducedMotion || current.inertiaHalfLifeMs <= 0) {
          velocity = { heading: 0, pitch: 0, zoom: 0 };
          if (grab?.kind === "zoom") grab = null;
        } else {
          if (velocity.heading || velocity.pitch) {
            next = { ...next, headingDeg: next.headingDeg + velocity.heading * dt, pitchDeg: next.pitchDeg + velocity.pitch * dt };
          }
          if (velocity.zoom) {
            const beforeFov = next.verticalFovDeg;
            if (grab?.kind === "zoom" && !velocity.heading && !velocity.pitch) {
              next = anchored(next, velocity.zoom * dt, grab.at, null, "zoom");
            } else {
              const requested = zoomFov(next.verticalFovDeg, velocity.zoom * dt);
              const view = readViewport();
              if (view && marker) {
                const at = projectSphereRay(next, view, marker.ray) ?? { x: view.width / 2, y: view.height / 2 };
                next = anchorSphereCamera(next, view, marker.ray, at, requested, limitsOf(current), at);
              } else {
                next = { ...next, verticalFovDeg: Math.min(current.fovRangeDeg.max, Math.max(current.fovRangeDeg.min, requested)) };
              }
            }
            if (dt > 0 && Math.abs(next.verticalFovDeg - beforeFov) < 1e-6) velocity = { ...velocity, zoom: 0 };
          }
          const decay = Math.pow(0.5, (dt * 1000) / current.inertiaHalfLifeMs);
          velocity = { heading: velocity.heading * decay, pitch: velocity.pitch * decay, zoom: velocity.zoom * decay };
          if ((next.pitchDeg >= current.pitchRangeDeg.max && velocity.pitch > 0) || (next.pitchDeg <= current.pitchRangeDeg.min && velocity.pitch < 0)) {
            velocity = { ...velocity, pitch: 0 };
          }
          const stopDegPerS = INERTIA_STOP_DEG_PER_S * Math.min(1, Math.max(0.05, swipeFovScale(next.verticalFovDeg)));
          if (Math.hypot(velocity.heading, velocity.pitch) < stopDegPerS) velocity = { ...velocity, heading: 0, pitch: 0 };
          if (Math.abs(velocity.zoom) < INERTIA_STOP_ZOOM_PER_S) {
            velocity = { ...velocity, zoom: 0 };
            if (grab?.kind === "zoom") grab = null;
          }
        }
      }
      if (rates.zoom) next = anchored(next, rates.zoom * current.zoomRate * dt, null, null);
      if (marker && !held && !velocity.heading && !velocity.pitch && !velocity.zoom) marker = null;
      if (next !== state) apply(next);
      else notifyAnchors();
      return this.moving();
    },
    moving: () => Boolean(rates.lookX || rates.lookY || rates.zoom || (!held && (velocity.heading || velocity.pitch || velocity.zoom))),
    cancelInertia() {
      velocity = { heading: 0, pitch: 0, zoom: 0 };
      grab = null;
      marker = null;
      notifyAnchors();
    },
  };
}
