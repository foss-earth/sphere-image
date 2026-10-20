/**
 * One input path for an image camera (docs/proposals/shared-image-viewer-implementation.md
 * §8): a live sphere's look or a rectangle surface's camera, bound to the
 * element that shows it. The engine's wheel classification and the shared
 * control-key policy come in as ports.
 */
import type { ActionIntentFrame } from "@felipegalind0/gamepad-tools/core";
import type { ImageCameraAnchor, ImageCameraTarget, SurfacePoint, TouchPair } from "./cameraTarget.js";
const WHEEL_LINE_PX = 16;
const WHEEL_NOTCH_PX = 100;
const PINCH_WHEEL_PX_PER_LOG_SCALE = 100;

/** A host-owned display of the camera's projected, surface-local gesture anchor. */
export interface ImageAnchorMarkers {
  show(anchor: ImageCameraAnchor | null): void;
  destroy(): void;
}

export interface LookInputOptions {
  window: Window;
  controlTakesKey(target: EventTarget | null, key: string): boolean;
  createWheelGestureClassifier(options: { isSafariWithGestures: boolean; mode(): "auto" | "mouse" | "trackpad"; precedingWheelMs?: number }): (event: WheelEvent) => "ignore" | "pan" | "orbit" | "pinchZoom" | "wheelZoom";
  /** The element that shows the image and takes its pointer input. */
  canvas: HTMLElement;
  model: ImageCameraTarget;
  /** A client point in the target's surface-local CSS pixels, or null; without it gestures anchor at the centre. */
  localPoint?: (clientX: number, clientY: number) => SurfacePoint | null;
  /** Optional gesture-anchor display. Nothing is created until enabled and an anchor is visible. */
  anchorMarkers?: {
    enabled(): boolean;
    create(canvas: HTMLElement): ImageAnchorMarkers;
    subscribe?(changed: () => void): () => void;
  };
  /**
   * Wheel and Safari gesture events through a router that keeps each gesture
   * with the element it began over; without one, this element listens itself.
   */
  router?: WheelGestureRouter;
  /** Whether this binding owns the keyboard now: one binding does at a time. Always, without it. */
  ownsKeys?: () => boolean;
  /** Escape and the controller's exit. */
  onExit(): void;
  /** Any look input: cancels an entry's expansion or an arrival's levelling. */
  onUserInput(): void;
  /** Something moved: a frame is needed, and while the model is `moving()`, its `step` on every frame. */
  requestFrame(): void;
  /** Whether a binding is being captured, which keeps input. */
  capturing?: () => boolean;
  /** How wheel events are read, as the globe reads them: the runtime's `input.mode`. */
  inputMode?: () => "auto" | "mouse" | "trackpad";
  /** Safari on macOS reports trackpad pinches as gesture events, and ctrl+wheel is not a pinch there. */
  safariGestures?: boolean;
  /**
   * Two touches off this element pinch it about their midpoint. One touch
   * off the element stays with whatever it landed on.
   */
  claimForeignTouch?: boolean;
  /** When the last wheel event came before looking began: a gesture under way then, such as a swipe's momentum over the globe, looks nowhere. */
  precedingWheelMs?: number;
}

/** Delivers one kind of routed event to the element that owns its gesture. */
export interface RoutedGestureHandlers {
  wheel(event: WheelEvent): void;
  gesture(event: Event): void;
}

/**
 * Chooses one owner for each wheel or Safari gesture at its start and keeps
 * it through the gesture, momentum included, wherever the pointer then goes:
 * a registered element's gesture reaches only that element, never the page or
 * the globe, and another owner's gesture never reaches a registered element.
 */
export interface WheelGestureRouter {
  register(element: HTMLElement, handlers: RoutedGestureHandlers): () => void;
  /** Drops the rest of the gesture under way, as a cancelled target must not receive its momentum. */
  suppressCurrent(): void;
  dispose(): void;
}

/** Below this gap between wheel events, ms, they are one gesture: the engine's WHEEL_GESTURE_IDLE_MS. */
const WHEEL_IDLE_MS = 180;

export function createWheelGestureRouter(options: {
  window: Window;
  nowMs(): number;
  idleMs?: number;
  /**
   * A wheel that began off every registered surface. Return the surface that
   * should take it, or null to leave it with the page. Called once, when the
   * gesture starts, and that choice is kept for the rest of it.
   */
  claimUnusedWheel?(target: EventTarget | null, event: WheelEvent): HTMLElement | null;
  /** A Safari pinch that began off every registered surface. Same lifetime as a claimed wheel. */
  claimUnusedGesture?(target: EventTarget | null, event: Event): HTMLElement | null;
}): WheelGestureRouter {
  const { window } = options;
  const idleMs = options.idleMs ?? WHEEL_IDLE_MS;
  const owners = new Map<HTMLElement, RoutedGestureHandlers>();
  let wheelOwner: HTMLElement | "other" | "suppressed" | null = null;
  let lastWheelMs = -Infinity;
  let gestureOwner: HTMLElement | "other" | "suppressed" | null = null;
  const ownerOf = (target: EventTarget | null): HTMLElement | "other" => {
    const View = window as unknown as { Node?: typeof Node };
    if (View.Node && target instanceof View.Node) for (const element of owners.keys()) if (element.contains(target)) return element;
    return "other";
  };
  const take = (event: Event): void => {
    event.stopImmediatePropagation();
    if (event.cancelable) event.preventDefault();
  };
  const claimed = (element: HTMLElement | null | undefined): HTMLElement | "other" => element && owners.has(element) ? element : "other";
  const onWheel = (event: Event): void => {
    const now = options.nowMs();
    if (now - lastWheelMs > idleMs || wheelOwner === null) {
      const direct = ownerOf(event.target);
      wheelOwner = direct !== "other" ? direct : claimed(options.claimUnusedWheel?.(event.target, event as WheelEvent));
    }
    lastWheelMs = now;
    if (wheelOwner === "other") return;
    take(event);
    if (wheelOwner !== "suppressed") owners.get(wheelOwner)?.wheel(event as WheelEvent);
  };
  const onGesture = (event: Event): void => {
    if (event.type === "gesturestart" || gestureOwner === null) {
      const direct = ownerOf(event.target);
      gestureOwner = direct !== "other" ? direct : claimed(options.claimUnusedGesture?.(event.target, event));
    }
    const owner = gestureOwner;
    if (event.type === "gestureend") gestureOwner = null;
    if (owner === "other") return;
    take(event);
    if (owner !== "suppressed") owners.get(owner)?.gesture(event);
  };
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) window.addEventListener(type, onGesture, { capture: true, passive: false } as AddEventListenerOptions);
  return {
    register(element, handlers) {
      owners.set(element, handlers);
      return () => {
        if (owners.get(element) !== handlers) return;
        owners.delete(element);
        if (wheelOwner === element) wheelOwner = "suppressed";
        if (gestureOwner === element) gestureOwner = "suppressed";
      };
    },
    suppressCurrent() {
      if (wheelOwner !== null && wheelOwner !== "other") wheelOwner = "suppressed";
      if (gestureOwner !== null && gestureOwner !== "other") gestureOwner = "suppressed";
    },
    dispose() {
      owners.clear();
      window.removeEventListener("wheel", onWheel, { capture: true });
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) window.removeEventListener(type, onGesture, { capture: true });
    },
  };
}

export interface LookInputBinding {
  applyIntents(frame: ActionIntentFrame): void;
  /**
   * Ends what is under way, as on a document change: captures, held rates,
   * anchors and glide, and the rest of a routed wheel gesture.
   */
  cancel(): void;
  detach(): void;
}

/** Binds image camera input; returns the controller-intent handler, cancellation and a detach function. */
export function attachLookInput(options: LookInputOptions): LookInputBinding {
  const { canvas, model, window } = options;
  const pointers = new Map<number, { x: number; y: number; at: number; mouseButtonMask: number }>();
  /** Touches that landed off the surface. They join a pinch once a second finger is down. */
  const outside = new Map<number, { x: number; y: number; at: number }>();
  let pinchFrom: TouchPair | null = null;
  let pinching = false;
  /** The last place a pointer was seen, for a Safari pinch without coordinates. */
  let hover: { x: number; y: number } | null = null;
  const local = (x: number, y: number): SurfacePoint | null => options.localPoint?.(x, y) ?? null;
  const keys = new Set<string>();
  const padRates = { lookX: 0, lookY: 0, zoom: 0 };
  const classifyWheel = options.createWheelGestureClassifier({
    isSafariWithGestures: options.safariGestures ?? false,
    mode: options.inputMode ?? (() => "auto"),
    precedingWheelMs: options.precedingWheelMs,
  });
  let gestureScale = 1;
  let attached = true;
  let markers: ImageAnchorMarkers | null = null;
  let markerTimer: number | null = null;
  let transientAnchor = false;
  let markersSuppressed = false;

  const clearMarkerTimer = (): void => {
    if (markerTimer !== null) window.clearTimeout(markerTimer);
    markerTimer = null;
  };
  const refreshMarkers = (): void => {
    const display = options.anchorMarkers;
    if (!display || !model.anchor) return;
    if (!attached || !display.enabled()) {
      markers?.destroy();
      markers = null;
      return;
    }
    const anchor = markersSuppressed ? null : model.anchor();
    const visible = anchor && (pointers.size > 0 || pinching || (anchor.grab && model.moving()) || transientAnchor) ? anchor : null;
    if (visible) markers ??= display.create(canvas);
    markers?.show(visible);
  };
  const beginContactMarkers = (): void => {
    markersSuppressed = false;
    transientAnchor = false;
    clearMarkerTimer();
  };
  const beginTransientMarkers = (): void => {
    if (!options.anchorMarkers || !model.anchor) return;
    markersSuppressed = false;
    transientAnchor = true;
    clearMarkerTimer();
    markerTimer = window.setTimeout(() => {
      markerTimer = null;
      transientAnchor = false;
      refreshMarkers();
    }, WHEEL_IDLE_MS);
  };
  const hideMarkers = (): void => {
    markersSuppressed = true;
    transientAnchor = false;
    clearMarkerTimer();
    markers?.show(null);
  };
  const unsubscribeAnchors = options.anchorMarkers ? model.subscribeAnchors?.(refreshMarkers) : undefined;
  const unsubscribeMarkers = options.anchorMarkers?.subscribe?.(refreshMarkers);
  const refreshUnsubscribedMarkers = (): void => { if (!unsubscribeAnchors) refreshMarkers(); };

  const syncRates = (): void => {
    const key = (name: string) => (keys.has(name) ? 1 : 0);
    const zoomKeys = key("+") + key("=") - key("-") - key("_");
    model.setRates({
      lookX: Math.max(-1, Math.min(1, key("ArrowRight") - key("ArrowLeft") + padRates.lookX)),
      lookY: Math.max(-1, Math.min(1, key("ArrowUp") - key("ArrowDown") + padRates.lookY)),
      zoom: Math.max(-1, Math.min(1, zoomKeys + padRates.zoom)),
    });
    refreshMarkers();
    if (model.moving()) options.requestFrame();
  };

  const pointOf = (clientX: number, clientY: number): SurfacePoint => local(clientX, clientY) ?? { x: clientX, y: clientY };
  const pairOf = (a: { x: number; y: number }, b: { x: number; y: number }): TouchPair => {
    const pa = pointOf(a.x, a.y), pb = pointOf(b.x, b.y);
    return { mid: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, separation: Math.hypot(pa.x - pb.x, pa.y - pb.y) };
  };
  /** The first two contacts, surface touches first. No list is built. */
  const firstTwo = (): readonly [{ x: number; y: number }, { x: number; y: number }] | null => {
    let a: { x: number; y: number } | null = null;
    let b: { x: number; y: number } | null = null;
    for (const point of pointers.values()) { if (!a) a = point; else { b = point; break; } }
    if (!b) for (const point of outside.values()) { if (!a) a = point; else { b = point; break; } }
    return a && b ? [a, b] : null;
  };
  const rebaseline = (): void => {
    const pair = firstTwo();
    pinchFrom = pair ? pairOf(pair[0], pair[1]) : null;
    pinching = pinchFrom !== null;
  };
  const applyPinch = (dtMs?: number): void => {
    const pair = firstTwo();
    if (!pair) { pinchFrom = null; pinching = false; return; }
    const now = pairOf(pair[0], pair[1]);
    if (pinchFrom && pinchFrom.separation > 0 && now.separation > 0) {
      beginContactMarkers();
      model.touchPinch(pinchFrom, now, dtMs);
      refreshUnsubscribedMarkers();
    }
    pinchFrom = now;
    pinching = true;
    options.requestFrame();
  };
  const finishContacts = (time: number, lastAt: number, drove: boolean): void => {
    if (pointers.size + outside.size >= 2) { rebaseline(); return; }
    pinchFrom = null;
    if (pointers.size > 0 || outside.size > 0) {
      if (pinching) hideMarkers();
      return;
    }
    if (!drove && !pinching) return;
    pinching = false;
    model.release(time - lastAt);
    refreshUnsubscribedMarkers();
    if (model.moving()) options.requestFrame();
  };
  const nodeOf = (options.window as unknown as { Node?: typeof Node }).Node;
  const overSurface = (target: EventTarget | null): boolean => Boolean(nodeOf && target instanceof nodeOf && canvas.contains(target));

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 2) return;
    beginContactMarkers();
    model.cancelInertia();
    options.onUserInput();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, at: event.timeStamp,
      mouseButtonMask: event.pointerType === "mouse" ? event.button === 2 ? 2 : 1 : 0 });
    try { canvas.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
    hover = { x: event.clientX, y: event.clientY };
    if (pointers.size + outside.size >= 2) rebaseline();
    else pinchFrom = null;
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent): void => {
    hover = { x: event.clientX, y: event.clientY };
    const last = pointers.get(event.pointerId);
    if (!last) return;
    // A release outside the browser may never arrive. Check before a returning pointer can drag.
    if (last.mouseButtonMask && (event.buttons & last.mouseButtonMask) === 0) { onPointerUp(event); return; }
    const current = { x: event.clientX, y: event.clientY, at: event.timeStamp, mouseButtonMask: last.mouseButtonMask };
    pointers.set(event.pointerId, current);
    if (pointers.size + outside.size >= 2) applyPinch(current.at - last.at);
    else {
      const from = local(last.x, last.y), to = local(current.x, current.y);
      beginContactMarkers();
      model.drag(from && to ? to.x - from.x : current.x - last.x, from && to ? to.y - from.y : current.y - last.y, current.at - last.at, from);
      refreshUnsubscribedMarkers();
      options.requestFrame();
    }
  };
  const onPointerUp = (event: PointerEvent): void => {
    const last = pointers.get(event.pointerId);
    if (!last || !pointers.delete(event.pointerId)) return;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* capture may already be lost */ }
    finishContacts(event.timeStamp, last.at, true);
  };
  const onPointerCancel = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) return;
    onPointerUp(event);
    hideMarkers();
    model.cancelInertia();
  };
  const onForeignDown = (event: PointerEvent): void => {
    if (!attached || event.pointerType !== "touch" || overSurface(event.target)) return;
    outside.set(event.pointerId, { x: event.clientX, y: event.clientY, at: event.timeStamp });
    hover = { x: event.clientX, y: event.clientY };
    if (pointers.size + outside.size < 2) return;
    event.preventDefault();
    event.stopPropagation();
    beginContactMarkers();
    model.cancelInertia();
    options.onUserInput();
    rebaseline();
  };
  const onForeignMove = (event: PointerEvent): void => {
    const last = outside.get(event.pointerId);
    if (!last) return;
    const dtMs = event.timeStamp - last.at;
    outside.set(event.pointerId, { x: event.clientX, y: event.clientY, at: event.timeStamp });
    hover = { x: event.clientX, y: event.clientY };
    if (pointers.size + outside.size < 2) return;
    event.preventDefault();
    event.stopPropagation();
    applyPinch(dtMs);
  };
  const onForeignUp = (event: PointerEvent): void => {
    const last = outside.get(event.pointerId);
    if (!last || !outside.delete(event.pointerId)) return;
    if (pointers.size + outside.size >= 2) { event.preventDefault(); event.stopPropagation(); }
    finishContacts(event.timeStamp, last.at, false);
  };
  const onForeignCancel = (event: PointerEvent): void => {
    if (!outside.has(event.pointerId)) return;
    onForeignUp(event);
    hideMarkers();
    model.cancelInertia();
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const gesture = classifyWheel(event);
    if (gesture === "ignore") return;
    options.onUserInput();
    const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_NOTCH_PX * 3 : 1;
    // A swipe, or shift+wheel, looks around: what pans or orbits the globe.
    if (gesture === "pan" || gesture === "orbit") {
      hideMarkers();
      model.swipe(event.deltaX * scale, event.deltaY * scale);
    } else {
      const at = local(event.clientX, event.clientY);
      beginTransientMarkers();
      if (gesture === "pinchZoom") model.pinchBy((-event.deltaY * scale) / PINCH_WHEEL_PX_PER_LOG_SCALE, at);
      else model.wheel(event.deltaY * scale, at);
    }
    refreshUnsubscribedMarkers();
    options.requestFrame();
  };
  /** A Safari gesture's own point when it has one, else the last pointer, else none: the centre. */
  const gesturePoint = (event: Event): SurfacePoint | null => {
    const { clientX, clientY } = event as Event & { clientX?: number; clientY?: number };
    if (typeof clientX === "number" && typeof clientY === "number" && Number.isFinite(clientX) && Number.isFinite(clientY) && (clientX !== 0 || clientY !== 0)) return local(clientX, clientY);
    return hover ? local(hover.x, hover.y) : null;
  };
  // Safari's trackpad pinch: `scale` is relative to the gesture's start.
  const onGestureStart = (event: Event): void => {
    event.preventDefault();
    gestureScale = 1;
  };
  const onGestureChange = (event: Event): void => {
    event.preventDefault();
    const next = (event as Event & { scale?: number }).scale;
    if (typeof next !== "number" || !(next > 0)) return;
    options.onUserInput();
    beginTransientMarkers();
    model.pinchBy(Math.log(next / gestureScale), gesturePoint(event));
    refreshUnsubscribedMarkers();
    gestureScale = next;
    options.requestFrame();
  };
  // Kept, so the end of the pinch does not reach the globe.
  const onGestureEnd = (event: Event): void => {
    event.preventDefault();
    gestureScale = 1;
  };
  const onRoutedGesture = (event: Event): void => {
    if (event.type === "gesturestart") onGestureStart(event);
    else if (event.type === "gesturechange") onGestureChange(event);
    else onGestureEnd(event);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (options.ownsKeys && !options.ownsKeys()) return;
    // A focused control keeps the keys it uses: a slider its arrows, a text field all of them.
    if (options.controlTakesKey(event.target, event.key) || options.capturing?.()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      options.onExit();
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_"].includes(event.key)) {
      event.preventDefault();
      options.onUserInput();
      keys.add(event.key);
      syncRates();
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (keys.delete(event.key)) syncRates();
  };
  const onBlur = (): void => {
    hideMarkers();
    keys.clear();
    const heldPointers = [...pointers.keys()];
    pointers.clear(); outside.clear(); pinchFrom = null; pinching = false;
    for (const id of heldPointers) { try { canvas.releasePointerCapture(id); } catch { /* released */ } }
    padRates.lookX = padRates.lookY = padRates.zoom = 0;
    gestureScale = 1;
    model.cancelInertia(); syncRates();
  };
  const onPointerLeave = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) hover = null;
  };
  const onContextMenu = (event: Event): void => { event.preventDefault(); };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("lostpointercapture", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("contextmenu", onContextMenu);
  const foreign = options.claimForeignTouch === true;
  if (foreign) {
    window.addEventListener("pointerdown", onForeignDown, { capture: true });
    window.addEventListener("pointermove", onForeignMove, { capture: true });
    window.addEventListener("pointerup", onForeignUp, { capture: true });
    window.addEventListener("pointercancel", onForeignCancel, { capture: true });
  }
  const unroute = options.router?.register(canvas, { wheel: onWheel, gesture: onRoutedGesture }) ?? null;
  if (!unroute) {
    canvas.addEventListener("wheel", onWheel, { passive: false });
    if (options.safariGestures) {
      canvas.addEventListener("gesturestart", onGestureStart, { passive: false });
      canvas.addEventListener("gesturechange", onGestureChange, { passive: false });
      canvas.addEventListener("gestureend", onGestureEnd, { passive: false });
    }
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return {
    applyIntents(frame) {
      if (!attached) return;
      let changed = false;
      for (const intent of frame.intents) {
        if (intent.kind === "command" && intent.actionId === "panorama.exit" && intent.edge === "press") options.onExit();
        if (intent.kind !== "rate") continue;
        const value = Number.isFinite(intent.value) ? Math.max(-1, Math.min(1, intent.value)) : 0;
        if (intent.actionId === "panorama.lookX") { padRates.lookX = value; changed = true; }
        if (intent.actionId === "panorama.lookY") { padRates.lookY = value; changed = true; }
        if (intent.actionId === "panorama.zoom") { padRates.zoom = value; changed = true; }
      }
      if (changed) {
        if (padRates.lookX || padRates.lookY || padRates.zoom) options.onUserInput();
        syncRates();
      }
    },
    cancel() {
      if (!attached) return;
      onBlur();
      hover = null;
      options.router?.suppressCurrent();
    },
    detach() {
      if (!attached) return; attached = false;
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("lostpointercapture", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("contextmenu", onContextMenu);
      if (foreign) {
        window.removeEventListener("pointerdown", onForeignDown, { capture: true });
        window.removeEventListener("pointermove", onForeignMove, { capture: true });
        window.removeEventListener("pointerup", onForeignUp, { capture: true });
        window.removeEventListener("pointercancel", onForeignCancel, { capture: true });
      }
      unroute?.();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
      canvas.removeEventListener("gestureend", onGestureEnd);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      unsubscribeAnchors?.();
      unsubscribeMarkers?.();
      hideMarkers();
      markers?.destroy();
      markers = null;
      for (const id of pointers.keys()) { try { canvas.releasePointerCapture(id); } catch { /* released */ } }
      pointers.clear();
      keys.clear();
      model.setRates({ lookX: 0, lookY: 0, zoom: 0 });
      model.cancelInertia();
    },
  };
}
