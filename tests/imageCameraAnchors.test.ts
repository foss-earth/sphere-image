import { describe, expect, it, vi } from "vitest";
import { createSphereCameraTarget, type ImageCameraAnchor } from "../src/cameraTarget.js";
import { createLookModel, type LookSettings } from "../src/look.js";
import { projectSphereRay, sphereRay, type SphereCamera, type SpherePoint, type SphereViewport } from "../src/sphereCamera.js";

const viewport = { width: 800, height: 600 };
const initial: SphereCamera = { headingDeg: 30, pitchDeg: 8, verticalFovDeg: 60 };
const settings: LookSettings = {
  dragMode: "grab",
  dragSensitivity: 0.15, swipeSensitivity: 0.1, lookRate: 90, zoomPerNotch: 0.1, zoomRate: 0.5, pinchGain: 1, inertiaHalfLifeMs: 100,
  fovRangeDeg: { min: 1, max: 150 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: false,
};

function expectPoint(anchor: ImageCameraAnchor | null, expected: SpherePoint | null): void {
  expect(anchor).not.toBeNull();
  expect(expected).not.toBeNull();
  expect(Math.hypot(anchor!.x - expected!.x, anchor!.y - expected!.y)).toBeLessThan(0.25);
}

describe("image camera anchor readings", () => {
  it("shows the grabbed image point behind a finger stopped by the pitch limit", () => {
    const start = { ...initial, pitchDeg: 84 };
    const model = createLookModel(start, () => settings, () => {}, () => viewport);
    const from = { x: 400, y: 300 }, pointer = { x: 400, y: 500 };
    const ray = sphereRay(start, viewport, from);
    model.drag(0, pointer.y - from.y, 16, from);

    const anchor = model.anchor();
    expectPoint(anchor, projectSphereRay(model.get(), viewport, ray));
    expect(anchor).toMatchObject({ grab: true, zoom: false, held: true });
    expect(anchor!.y).toBeGreaterThan(from.y);
    expect(anchor!.y).toBeLessThan(pointer.y - 100);

    model.drag(0, 50, 16, pointer);
    expectPoint(model.anchor(), anchor);
  });

  it("reports one projected midpoint for a two-touch pan and pinch", () => {
    const model = createLookModel(initial, () => settings, () => {}, () => viewport);
    const from = { mid: { x: 500, y: 280 }, separation: 100 };
    const to = { mid: { x: 525, y: 300 }, separation: 140 };
    const ray = sphereRay(initial, viewport, from.mid);
    model.touchPinch(from, to);

    expectPoint(model.anchor(), to.mid);
    expectPoint(model.anchor(), projectSphereRay(model.get(), viewport, ray));
    expect(model.anchor()).toMatchObject({ grab: true, zoom: true, held: true });
    model.release();
    expect(model.anchor()).toBeNull();
  });

  it("clears any anchor on a trackpad swipe and shows a zoom anchor on a wheel zoom", () => {
    const model = createLookModel(initial, () => settings, () => {}, () => viewport);
    const at = { x: 550, y: 260 };
    model.drag(10, -5, 16, at);
    expect(model.anchor()).toMatchObject({ grab: true, zoom: false, held: true });

    model.swipe(20, -12);
    expect(model.anchor()).toBeNull();

    model.wheel(-100, at);
    expectPoint(model.anchor(), at);
    expect(model.anchor()).toMatchObject({ grab: false, zoom: true, held: true });
  });

  it("follows the grabbed image point during release glide and clears it when motion ends", () => {
    const model = createLookModel(initial, () => settings, () => {}, () => viewport);
    const from = { x: 430, y: 290 };
    const ray = sphereRay(initial, viewport, from);
    model.drag(8, -2, 16, from);
    const held = model.anchor();
    expect(held).toMatchObject({ held: true });

    model.release();
    expect(model.anchor()).toMatchObject({ grab: true, zoom: false, held: false });
    expectPoint(model.anchor(), held);
    expect(model.step(32)).toBe(true);
    expectPoint(model.anchor(), projectSphereRay(model.get(), viewport, ray));
    expect(model.anchor()!.x).toBeGreaterThan(held!.x);
    expect(model.anchor()).toMatchObject({ held: false });

    for (let frame = 0; frame < 40 && model.moving(); frame++) model.step(100);
    expect(model.moving()).toBe(false);
    expect(model.anchor()).toBeNull();
  });

  it.each(["cancel", "set"] as const)("clears the marker when %s ends its camera gesture", finish => {
    const model = createLookModel(initial, () => settings, () => {}, () => viewport);
    model.drag(12, 5, 16, { x: 460, y: 280 });
    expect(model.anchor()).not.toBeNull();
    if (finish === "cancel") model.cancelInertia();
    else model.set(initial);
    expect(model.anchor()).toBeNull();
    expect(model.moving()).toBe(false);
  });

  it.each(["drag", "swipe", "wheel"] as const)("does not revive an old marker after an unmeasured %s", gesture => {
    let measured: SphereViewport | null = viewport;
    const model = createLookModel(initial, () => settings, () => {}, () => measured);
    const at = { x: 460, y: 280 };
    model.drag(12, 5, 16, at);
    expect(model.anchor()).not.toBeNull();

    measured = null;
    if (gesture === "drag") model.drag(12, 5, 16, at);
    else if (gesture === "swipe") model.swipe(12, 5);
    else model.wheel(-100, at);
    expect(model.anchor()).toBeNull();
    measured = viewport;
    expect(model.anchor()).toBeNull();
  });

  it("notifies subscribers after gesture and camera changes and supports unsubscribe", () => {
    const model = createLookModel(initial, () => settings, () => {}, () => viewport);
    const changed = vi.fn(() => model.anchor());
    const unsubscribe = model.subscribeAnchors(changed);
    model.drag(8, -2, 16, { x: 430, y: 290 });
    expect(changed).toHaveLastReturnedWith(expect.objectContaining({ grab: true, held: true }));
    model.release();
    expect(changed).toHaveLastReturnedWith(expect.objectContaining({ held: false }));
    model.step(32);
    expect(changed).toHaveLastReturnedWith(model.anchor());
    model.cancelInertia();
    expect(changed).toHaveLastReturnedWith(null);

    unsubscribe();
    changed.mockClear();
    model.wheel(-100, { x: 550, y: 260 });
    expect(model.anchor()).not.toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it("lets a surface subscribe before a camera exists and observe its later gestures", () => {
    let camera: SphereCamera | null = null;
    const target = createSphereCameraTarget({
      get: () => camera,
      set: next => { camera = next; },
      viewport: () => viewport,
      settings: () => settings,
    });
    const changed = vi.fn(() => target.anchor?.());
    const unsubscribe = target.subscribeAnchors!(changed);
    expect(target.anchor!()).toBeNull();
    target.drag(8, -2, 16, { x: 430, y: 290 });
    expect(changed).not.toHaveBeenCalled();

    camera = initial;
    target.drag(8, -2, 16, { x: 430, y: 290 });
    expectPoint(target.anchor!(), { x: 438, y: 288 });
    expect(changed).toHaveLastReturnedWith(expect.objectContaining({ grab: true, held: true }));
    target.release();
    expect(changed).toHaveLastReturnedWith(expect.objectContaining({ held: false }));
    target.cancelInertia();
    expect(changed).toHaveLastReturnedWith(null);

    unsubscribe();
    changed.mockClear();
    target.wheel(-100, { x: 550, y: 260 });
    expect(target.anchor!()).not.toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
});
