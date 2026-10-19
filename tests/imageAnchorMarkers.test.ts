// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachLookInput, type ImageAnchorMarkers } from "../src/browserInput.js";
import { createLookModel, swipeFovScale, type LookSettings, type LookState } from "../src/look.js";
import { projectSphereRay, sphereRay, type SpherePoint } from "../src/sphereCamera.js";

const viewport = { width: 800, height: 600 };
const offset = { x: 130, y: 75 };
const settings: LookSettings = {
  dragMode: "grab",
  dragSensitivity: 0.15, swipeSensitivity: 0.1, lookRate: 90, zoomPerNotch: 0.1, zoomRate: 0.5, pinchGain: 1, inertiaHalfLifeMs: 100,
  fovRangeDeg: { min: 10, max: 150 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: false,
};
const bindings: ReturnType<typeof attachLookInput>[] = [];

function setup(options: { enabled?: boolean; markerSupport?: boolean; start?: LookState; gesture?: "pan" | "wheelZoom" } = {}) {
  vi.useFakeTimers();
  const canvas = document.createElement("canvas");
  canvas.setPointerCapture = vi.fn();
  canvas.releasePointerCapture = vi.fn();
  document.body.append(canvas);
  let enabled = options.enabled ?? false;
  const listeners = new Set<() => void>();
  const displays: { show: ReturnType<typeof vi.fn<ImageAnchorMarkers["show"]>>; destroy: ReturnType<typeof vi.fn> }[] = [];
  const create = vi.fn(() => {
    const display = { show: vi.fn<ImageAnchorMarkers["show"]>(), destroy: vi.fn() };
    displays.push(display);
    return display;
  });
  let currentGesture = options.gesture ?? "wheelZoom";
  const model = createLookModel(options.start ?? { headingDeg: 0.1, pitchDeg: 8, verticalFovDeg: 10 }, () => settings, () => {}, () => viewport);
  const binding = attachLookInput({
    window, canvas, model,
    localPoint: (x, y) => ({ x: x - offset.x, y: y - offset.y }),
    controlTakesKey: () => false,
    createWheelGestureClassifier: () => () => currentGesture,
    anchorMarkers: options.markerSupport === false ? undefined : {
      enabled: () => enabled,
      create,
      subscribe(changed) { listeners.add(changed); return () => { listeners.delete(changed); }; },
    },
    onExit: vi.fn(), onUserInput: vi.fn(), requestFrame: vi.fn(), safariGestures: true,
  });
  bindings.push(binding);
  const setGesture = (next: "pan" | "wheelZoom") => { currentGesture = next; };
  const toggle = (next: boolean) => { enabled = next; for (const changed of listeners) changed(); };
  const latest = () => displays.at(-1)?.show.mock.lastCall?.[0] ?? null;
  const wheel = (point: SpherePoint, dx = 0, dy = -20) => canvas.dispatchEvent(new WheelEvent("wheel", {
    cancelable: true, deltaX: dx, deltaY: dy, clientX: point.x + offset.x, clientY: point.y + offset.y,
  }));
  const pointer = (type: string, id: number, point: SpherePoint, time: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: id, pointerType: "touch", button: 0, clientX: point.x + offset.x, clientY: point.y + offset.y });
    Object.defineProperty(event, "timeStamp", { value: time });
    canvas.dispatchEvent(event);
  };
  return { canvas, model, binding, create, displays, listeners, setGesture, toggle, latest, wheel, pointer };
}

afterEach(() => {
  for (const binding of bindings.splice(0)) binding.detach();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("optional image gesture anchors", () => {
  it("creates nothing while disabled, toggles during a gesture, and never revives an expired wheel anchor", () => {
    const { canvas, create, displays, toggle, latest, wheel } = setup();
    wheel({ x: 580, y: 250 });
    expect(create).not.toHaveBeenCalled();
    toggle(true);
    expect(create).toHaveBeenCalledExactlyOnceWith(canvas);
    expect(latest()).toMatchObject({ x: expect.closeTo(580, 5), y: expect.closeTo(250, 5), grab: false, zoom: true });
    toggle(false);
    expect(displays[0].destroy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(180);
    toggle(true);
    expect(create).toHaveBeenCalledTimes(1);
    wheel({ x: 300, y: 200 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(latest()).toMatchObject({ x: expect.closeTo(300, 5), y: expect.closeTo(200, 5), grab: false, zoom: true });
  });

  it("shows the actual grabbed ray at a pitch limit and keeps it visible while the finger rests", () => {
    const { model, pointer, latest, create, toggle } = setup({ start: { headingDeg: 42, pitchDeg: 80, verticalFovDeg: 70 } });
    const from = { x: 400, y: 300 }, to = { x: 400, y: 900 };
    const ray = sphereRay(model.get(), viewport, from);
    pointer("pointerdown", 1, from, 100);
    pointer("pointermove", 1, to, 116);
    expect(create).not.toHaveBeenCalled();
    toggle(true);
    const projected = projectSphereRay(model.get(), viewport, ray)!;
    expect(latest()?.x).toBeCloseTo(projected.x, 6);
    expect(latest()?.y).toBeCloseTo(projected.y, 6);
    expect(Math.abs(projected.y - to.y)).toBeGreaterThan(100);
    expect(latest()).toMatchObject({ grab: true, zoom: false, held: true });
    vi.advanceTimersByTime(1_000);
    expect(latest()).not.toBeNull();
    pointer("pointerup", 1, to, 216);
    expect(latest()).toBeNull();
  });

  it("shows a two-finger pan and zoom at the projected midpoint", () => {
    const { model, pointer, latest } = setup({ enabled: true });
    const from = { x: 500, y: 290 };
    const ray = sphereRay(model.get(), viewport, from);
    pointer("pointerdown", 1, { x: 450, y: 290 }, 100);
    pointer("pointerdown", 2, { x: 550, y: 290 }, 100);
    pointer("pointermove", 1, { x: 460, y: 300 }, 116);
    pointer("pointermove", 2, { x: 580, y: 300 }, 120);
    const projected = projectSphereRay(model.get(), viewport, ray)!;
    expect(latest()?.x).toBeCloseTo(projected.x, 6);
    expect(latest()?.y).toBeCloseTo(projected.y, 6);
    expect(latest()).toMatchObject({ grab: true, zoom: true, held: true });
    vi.advanceTimersByTime(500);
    expect(latest()).not.toBeNull();
    pointer("pointerup", 1, { x: 460, y: 300 }, 220);
    pointer("pointerup", 2, { x: 580, y: 300 }, 220);
    expect(latest()).toBeNull();
  });

  it("replaces one-finger, two-finger and resumed one-finger anchors without leaving a stale midpoint", () => {
    const { pointer, latest } = setup({ enabled: true });
    pointer("pointerdown", 1, { x: 450, y: 290 }, 100);
    pointer("pointermove", 1, { x: 460, y: 290 }, 116);
    expect(latest()).toMatchObject({ grab: true, zoom: false });
    pointer("pointerdown", 2, { x: 550, y: 290 }, 120);
    expect(latest()).toBeNull();
    pointer("pointermove", 2, { x: 570, y: 300 }, 136);
    expect(latest()).toMatchObject({ grab: true, zoom: true });
    pointer("pointerup", 2, { x: 570, y: 300 }, 140);
    expect(latest()).toBeNull();
    vi.advanceTimersByTime(300);
    expect(latest()).toBeNull();
    pointer("pointermove", 1, { x: 470, y: 290 }, 152);
    expect(latest()).toMatchObject({ x: expect.closeTo(470, 5), y: expect.closeTo(290, 5), grab: true, zoom: false });
  });

  it("never creates or shows anchor markers for a trackpad swipe, and hides any active marker", () => {
    const { model, latest, wheel, create, setGesture } = setup({ enabled: true, gesture: "pan", start: { headingDeg: 42, pitchDeg: 20, verticalFovDeg: 70 } });
    const scale = swipeFovScale(70);
    wheel({ x: 580, y: 250 }, 26, -14);
    wheel({ x: 180, y: 500 }, 33, 16);
    expect(create).not.toHaveBeenCalled();
    expect(latest()).toBeNull();
    for (let i = 0; i < 600 && model.moving(); i++) model.step(1000 / 60);
    expect(model.get().headingDeg).toBeCloseTo(42 + 5.9 * scale, 2);
    expect(model.get().pitchDeg).toBeCloseTo(20 - 0.2 * scale, 2);
    expect(latest()).toBeNull();

    // If a wheel zoom created a transient marker earlier, a swipe hides it at once.
    setGesture("wheelZoom");
    wheel({ x: 400, y: 300 }, 0, -100);
    expect(create).toHaveBeenCalledTimes(1);
    expect(latest()).not.toBeNull();
    setGesture("pan");
    wheel({ x: 400, y: 300 }, 10, -5);
    expect(latest()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires wheelZoom markers 180ms after the last wheel event using one timer", () => {
    const { model, latest, wheel, toggle, create } = setup({ enabled: true, gesture: "wheelZoom" });
    const at = { x: 580, y: 250 };
    const ray = sphereRay(model.get(), viewport, at);
    wheel(at, 26, -14);
    const projected = projectSphereRay(model.get(), viewport, ray)!;
    expect(latest()?.x).toBeCloseTo(projected.x, 6);
    expect(latest()?.y).toBeCloseTo(projected.y, 6);
    vi.advanceTimersByTime(150);
    wheel(at, 26, -14);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(179);
    expect(latest()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(latest()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    toggle(false); toggle(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("expires Safari pinch markers after their last change", () => {
    const { canvas, latest } = setup({ enabled: true });
    const gesture = (type: string, scale: number) => {
      const event = new Event(type, { cancelable: true });
      Object.assign(event, { scale, clientX: 580 + offset.x, clientY: 250 + offset.y });
      canvas.dispatchEvent(event);
    };
    gesture("gesturestart", 1);
    gesture("gesturechange", 1.2);
    expect(latest()).toMatchObject({ x: expect.closeTo(580, 5), y: expect.closeTo(250, 5), grab: false, zoom: true });
    gesture("gestureend", 1.2);
    vi.advanceTimersByTime(179);
    expect(latest()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(latest()).toBeNull();
  });

  it("follows a released anchor through inertia and hides it when the glide ends", () => {
    const { model, pointer, latest } = setup({ enabled: true });
    const from = { x: 400, y: 300 }, to = { x: 420, y: 300 };
    const ray = sphereRay(model.get(), viewport, from);
    pointer("pointerdown", 1, from, 100);
    pointer("pointermove", 1, to, 116);
    pointer("pointerup", 1, to, 120);
    expect(latest()).toMatchObject({ held: false, grab: true });
    vi.advanceTimersByTime(300);
    expect(latest()).not.toBeNull();
    model.step(16);
    const projected = projectSphereRay(model.get(), viewport, ray)!;
    expect(latest()?.x).toBeCloseTo(projected.x, 6);
    expect(Math.abs(projected.x - to.x)).toBeGreaterThan(1);
    for (let step = 0; step < 100 && model.moving(); step++) model.step(100);
    expect(model.moving()).toBe(false);
    expect(latest()).toBeNull();
  });

  it.each(["blur", "cancel", "pointercancel"] as const)("hides on %s and cleans timers and subscriptions on detach", finish => {
    const { model, binding, pointer, latest, displays, listeners, wheel, toggle } = setup({ enabled: true });
    pointer("pointerdown", 1, { x: 400, y: 300 }, 100);
    pointer("pointermove", 1, { x: 420, y: 300 }, 116);
    if (finish === "blur") window.dispatchEvent(new Event("blur"));
    else if (finish === "cancel") binding.cancel();
    else pointer("pointercancel", 1, { x: 420, y: 300 }, 120);
    expect(latest()).toBeNull();
    expect(model.moving()).toBe(false);
    wheel({ x: 500, y: 200 });
    expect(latest()).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    binding.detach(); binding.detach();
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.size).toBe(0);
    expect(displays[0].destroy).toHaveBeenCalledTimes(1);
    const calls = displays[0].show.mock.calls.length;
    model.wheel(-100, { x: 300, y: 200 });
    toggle(false); toggle(true);
    expect(displays[0].show).toHaveBeenCalledTimes(calls);
  });
});
