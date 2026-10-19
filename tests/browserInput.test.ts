// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { attachLookInput } from "../src/browserInput.js";
import { createLookModel, swipeFovScale, zoomFov, type LookSettings } from "../src/index.js";
import { projectSphereRay, sphereRay, type SpherePoint } from "../src/sphereCamera.js";
import { controlTakesKey } from "@felipegalind0/gamepad-tools/browser";
import { createWheelGestureClassifier as createEngineWheelGestureClassifier } from "@foss-earth/engine/core";
const createWheelGestureClassifier: Parameters<typeof attachLookInput>[0]["createWheelGestureClassifier"] = options =>
  createEngineWheelGestureClassifier({ ...options, nowMs: () => performance.now() });

const SETTINGS: LookSettings = {
  dragSensitivity: 0.15, swipeSensitivity: 0.1, lookRate: 90, zoomPerNotch: 0.1, zoomRate: 0.5, pinchGain: 1, inertiaHalfLifeMs: 100,
  fovRangeDeg: { min: 35, max: 90 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: false,
};
const FRAME_MS = 1000 / 60;
const settle = (model: ReturnType<typeof createLookModel>) => {
  for (let i = 0; i < 600 && model.moving(); i++) model.step(FRAME_MS);
};

describe("sphere look input", () => {
  it("exits on Escape but not while typing, and sends controller look and exit to the model", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const onExit = vi.fn();
    const model = createLookModel({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const input = attachLookInput({ canvas, model, window, controlTakesKey, createWheelGestureClassifier, onExit, onUserInput: vi.fn(), requestFrame: vi.fn() });
    const field = document.createElement("input");
    document.body.append(field);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onExit).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onExit).toHaveBeenCalledTimes(1);
    input.applyIntents({ dt: 0.1, intents: [
      { kind: "rate", actionId: "panorama.lookX", value: 1, dt: 0.1 },
      { kind: "command", actionId: "panorama.exit", edge: "press" },
    ] } as never);
    expect(onExit).toHaveBeenCalledTimes(2);
    expect(model.moving()).toBe(true);
    input.detach();
    expect(model.moving()).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it("leaves a focused slider its arrow keys, and the rest to the sphere", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const onExit = vi.fn();
    const model = createLookModel({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const input = attachLookInput({ canvas, model, window, controlTakesKey, createWheelGestureClassifier, onExit, onUserInput: vi.fn(), requestFrame: vi.fn() });
    const slider = document.createElement("input");
    slider.type = "range";
    document.body.append(slider);
    // The arrow moves the slider's thumb, and only that.
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(model.moving()).toBe(false);
    slider.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    // A slider has no use for Escape: it still leaves the sphere.
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onExit).toHaveBeenCalledTimes(1);
    // A button keeps Space and Enter, so the arrows look.
    const button = document.createElement("button");
    document.body.append(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(model.moving()).toBe(true);
    input.detach();
  });
});

describe("sphere wheel input", () => {
  const wheel = (init: WheelEventInit) => new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  const attach = (mode: "trackpad" | "mouse") => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const model = createLookModel({ headingDeg: 90, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const input = attachLookInput({ canvas, model, window, controlTakesKey, createWheelGestureClassifier, onExit: vi.fn(), onUserInput: vi.fn(), requestFrame: vi.fn(), inputMode: () => mode });
    return { canvas, model, input };
  };

  it("in trackpad mode looks around with a two-finger swipe, and zooms with a pinch", () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const { canvas, model, input } = attach("trackpad");
    const scale = swipeFovScale(60);
    canvas.dispatchEvent(wheel({ deltaX: 30, deltaY: -20 }));
    expect(model.moving()).toBe(true);
    settle(model);
    expect(model.get().headingDeg).toBeCloseTo(90 + 3 * scale, 2);
    expect(model.get().pitchDeg).toBeCloseTo(2 * scale, 2);
    expect(model.get().verticalFovDeg).toBe(60);
    // A pause ends the swipe; the pinch that follows is its own gesture.
    vi.spyOn(performance, "now").mockReturnValue(2_000);
    canvas.dispatchEvent(wheel({ deltaY: -10, ctrlKey: true }));
    expect(model.moving()).toBe(true);
    settle(model);
    expect(model.get().verticalFovDeg).toBeCloseTo(zoomFov(60, 0.1), 2);
    expect(model.get().headingDeg).toBeCloseTo(90 + 3 * scale, 2);
    input.detach();
    vi.restoreAllMocks();
  });

  it("in mouse mode zooms with the wheel, gliding to the target FOV", () => {
    const { canvas, model, input } = attach("mouse");
    canvas.dispatchEvent(wheel({ deltaY: -100 }));
    expect(model.moving()).toBe(true);
    settle(model);
    expect(model.get().verticalFovDeg).toBeCloseTo(zoomFov(60, 0.1), 2);
    expect(model.get().headingDeg).toBe(90);
    input.detach();
  });
});

describe("measured sphere pan input", () => {
  const viewport = { width: 800, height: 600 };
  const offset = { x: 130, y: 75 };
  const attach = () => {
    const canvas = document.createElement("canvas");
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    document.body.append(canvas);
    const settings: LookSettings = { ...SETTINGS, dragMode: "grab", fovRangeDeg: { min: 10, max: 150 } };
    const model = createLookModel({ headingDeg: 0.1, pitchDeg: 8, verticalFovDeg: 10 }, () => settings, () => {}, () => viewport);
    const input = attachLookInput({
      canvas, model, window, controlTakesKey, createWheelGestureClassifier,
      localPoint: (x, y) => ({ x: x - offset.x, y: y - offset.y }),
      onExit: vi.fn(), onUserInput: vi.fn(), requestFrame: vi.fn(), inputMode: () => "trackpad",
    });
    return { canvas, model, input };
  };
  const pointer = (canvas: HTMLCanvasElement, type: string, id: number, at: SpherePoint, time: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: id, pointerType: "touch", button: 0, clientX: at.x + offset.x, clientY: at.y + offset.y });
    Object.defineProperty(event, "timeStamp", { value: time });
    canvas.dispatchEvent(event);
  };
  const expectRayAt = (model: ReturnType<typeof createLookModel>, ray: ReturnType<typeof sphereRay>, point: SpherePoint) => {
    const projected = projectSphereRay(model.get(), viewport, ray);
    expect(projected).not.toBeNull();
    expect(Math.hypot(projected!.x - point.x, projected!.y - point.y)).toBeLessThan(0.25);
  };

  it("passes a finger's surface-local source point and does not drift while it is held", () => {
    const { canvas, model, input } = attach();
    const from = { x: 580, y: 260 }, to = { x: 607, y: 247 };
    const ray = sphereRay(model.get(), viewport, from);
    pointer(canvas, "pointerdown", 1, from, 100);
    pointer(canvas, "pointermove", 1, to, 116);
    expectRayAt(model, ray, to);
    model.step(100);
    expect(model.moving()).toBe(false);
    expectRayAt(model, ray, to);
    pointer(canvas, "pointerup", 1, to, 216);
    expect(model.step(100)).toBe(false);
    expectRayAt(model, ray, to);
    input.detach();
  });

  it("turns heading and pitch on a trackpad pan regardless of pointer position, scaled with FOV and gliding with inertia", () => {
    const { canvas, model, input } = attach();
    const scale = swipeFovScale(10);
    canvas.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaX: 26, deltaY: -14,
      clientX: -500, clientY: 9_000,
    }));
    expect(model.anchor()).toBeNull();
    expect(model.moving()).toBe(true);
    settle(model);
    expect(model.get().headingDeg).toBeCloseTo(0.1 + 2.6 * scale, 2);
    expect(model.get().pitchDeg).toBeCloseTo(8 + 1.4 * scale, 2);
    expect(model.anchor()).toBeNull();
    expect(model.moving()).toBe(false);
    input.detach();
  });

  it("reanchors a one-finger drag through a two-touch midpoint pan and back to one finger", () => {
    const { canvas, model, input } = attach();
    const first = { x: 450, y: 300 }, firstMoved = { x: 470, y: 290 };
    const firstRay = sphereRay(model.get(), viewport, first);
    pointer(canvas, "pointerdown", 1, first, 100);
    pointer(canvas, "pointermove", 1, firstMoved, 116);
    expectRayAt(model, firstRay, firstMoved);

    const beforeSecond = model.get();
    pointer(canvas, "pointerdown", 2, { x: 550, y: 290 }, 120);
    expect(model.get()).toEqual(beforeSecond);
    const midpointRay = sphereRay(model.get(), viewport, { x: 510, y: 290 });
    pointer(canvas, "pointermove", 1, { x: 490, y: 300 }, 132);
    pointer(canvas, "pointermove", 2, { x: 570, y: 300 }, 136);
    expectRayAt(model, midpointRay, { x: 530, y: 300 });
    expect(model.get().verticalFovDeg).toBeCloseTo(beforeSecond.verticalFovDeg, 6);

    const beforeLift = model.get();
    pointer(canvas, "pointerup", 2, { x: 570, y: 300 }, 140);
    expect(model.get()).toEqual(beforeLift);
    const remainingRay = sphereRay(model.get(), viewport, { x: 490, y: 300 });
    const remainingTo = { x: 503, y: 294 };
    pointer(canvas, "pointermove", 1, remainingTo, 152);
    expectRayAt(model, remainingRay, remainingTo);
    model.step(100);
    expect(model.moving()).toBe(false);
    expectRayAt(model, remainingRay, remainingTo);
    pointer(canvas, "pointerup", 1, remainingTo, 252);
    expect(model.step(100)).toBe(false);
    input.detach();
  });
});

describe("detached input lifecycle", () => {
  it("releases pointer capture once and ignores late controller frames", () => {
    const canvas = document.createElement("canvas");
    canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    const model = createLookModel({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 }, () => SETTINGS, () => {});
    const onExit = vi.fn(), onUserInput = vi.fn(), requestFrame = vi.fn();
    const binding = attachLookInput({ canvas, model, window, controlTakesKey, createWheelGestureClassifier, onExit, onUserInput, requestFrame });
    const down = new Event("pointerdown", { cancelable: true });
    Object.assign(down, { pointerId: 42, pointerType: "touch", button: 0, clientX: 10, clientY: 20 });
    canvas.dispatchEvent(down);
    binding.detach(); binding.detach();
    expect(canvas.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(42);
    const calls = onUserInput.mock.calls.length;
    binding.applyIntents({ dt: .1, intents: [ { kind: "rate", actionId: "panorama.lookX", value: 1, dt: .1 }, { kind: "command", actionId: "panorama.exit", edge: "press" } ] } as never);
    expect(model.moving()).toBe(false); expect(onExit).not.toHaveBeenCalled(); expect(onUserInput).toHaveBeenCalledTimes(calls);
  });
});
