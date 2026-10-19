import { describe, expect, it } from "vitest";
import { createSphereCameraTarget } from "../src/cameraTarget.js";
import { createLookModel, swipeFovScale, zoomFov, type LookSettings } from "../src/look.js";
import { projectSphereRay, sphereRay, type SphereCamera } from "../src/sphereCamera.js";

const settings: LookSettings = {
  dragSensitivity: 0.15, swipeSensitivity: 0.1, lookRate: 90, zoomPerNotch: 0.1, zoomRate: 0.5, pinchGain: 1, inertiaHalfLifeMs: 0,
  fovRangeDeg: { min: 10, max: 150 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: true,
};
const viewport = { width: 800, height: 600 };
const start: SphereCamera = { headingDeg: 30, pitchDeg: 8, verticalFovDeg: 70 };
const FRAME_MS = 1000 / 60;
const settle = (model: { moving(): boolean; step(dtMs: number): boolean }) => {
  for (let i = 0; i < 600 && model.moving(); i++) model.step(FRAME_MS);
};

function errorAt(camera: SphereCamera, ray: readonly [number, number, number], point: { x: number; y: number }): number {
  const projected = projectSphereRay(camera, viewport, ray);
  if (!projected) return Infinity;
  return Math.hypot(projected.x - point.x, projected.y - point.y);
}

describe("shared sphere look", () => {
  describe("relative XY drag", () => {
    const scrollSettings: LookSettings = { ...settings, dragMode: "scroll" };
    const phone = { width: 390, height: 780 };

    it.each([0, 40, -40, 60, -60])("pans equally from the top, middle and bottom at pitch %s, then retraces the drag", pitchDeg => {
      const initial = { headingDeg: 0, pitchDeg, verticalFovDeg: 100 };
      const turns: SphereCamera[] = [];
      for (const y of [78, 390, 702]) {
        const model = createLookModel(initial, () => scrollSettings, () => {}, () => phone);
        let point = { x: 195, y };
        for (let frame = 0; frame < 60; frame++) {
          model.drag(2, 0, 16, point);
          point = { x: point.x + 2, y };
        }
        turns.push(model.get());
        expect(model.anchor()).toBeNull();
        expect(model.get().pitchDeg).toBe(pitchDeg);
        expect(model.get().headingDeg).toBeGreaterThan(330);
        expect(model.get().headingDeg).toBeLessThan(345);
        for (let frame = 0; frame < 60; frame++) {
          model.drag(-2, 0, 16, point);
          point = { x: point.x - 2, y };
        }
        expect(model.get().headingDeg).toBeCloseTo(initial.headingDeg, 8);
        expect(model.get().pitchDeg).toBe(initial.pitchDeg);
        expect(model.get().verticalFovDeg).toBe(initial.verticalFovDeg);
        expect(model.anchor()).toBeNull();
      }
      expect(turns[0]).toEqual(turns[1]);
      expect(turns[1]).toEqual(turns[2]);
    });

    it.each([20, 90, 140])("scales both axes with the measured view at %s degrees FOV", verticalFovDeg => {
      const initial = { ...start, verticalFovDeg };
      const model = createLookModel(initial, () => scrollSettings, () => {}, () => viewport);
      const gain = 2 * Math.tan(verticalFovDeg * Math.PI / 360) / viewport.height * 180 / Math.PI;
      model.drag(30, -20, 16, { x: 760, y: 12 });
      expect(model.get().headingDeg).toBeCloseTo((start.headingDeg - 30 * gain + 360) % 360, 8);
      expect(model.get().pitchDeg).toBeCloseTo(start.pitchDeg - 20 * gain, 8);
      expect(model.get().verticalFovDeg).toBe(verticalFovDeg);
      expect(model.anchor()).toBeNull();

      const larger = createLookModel(initial, () => scrollSettings, () => {}, () => ({ width: 600, height: 1_200 }));
      larger.drag(60, -40, 16, { x: 10, y: 1_100 });
      expect(larger.get()).toEqual(model.get());
    });

    it("uses the live fallback sensitivity without a measured view", () => {
      let current: LookSettings = { ...scrollSettings, dragSensitivity: 0.4 };
      const model = createLookModel(start, () => current, () => {});
      model.drag(12, -8, 16, { x: 10, y: 10 });
      expect(model.get().headingDeg).toBeCloseTo(25.2, 8);
      expect(model.get().pitchDeg).toBeCloseTo(4.8, 8);
      current = { ...current, dragSensitivity: 0.2 };
      model.drag(12, -8, 16, { x: 10, y: 700 });
      expect(model.get().headingDeg).toBeCloseTo(22.8, 8);
      expect(model.get().pitchDeg).toBeCloseTo(3.2, 8);
      expect(model.anchor()).toBeNull();
    });

    it.each([-1, 1])("continues horizontally at pitch bound %s and reverses vertically on the first pixel", sign => {
      const initial = { ...start, pitchDeg: sign * 84 };
      const model = createLookModel(initial, () => scrollSettings, () => {}, () => viewport);
      model.drag(0, sign * 100, 16, { x: 400, y: 300 });
      expect(model.get().pitchDeg).toBe(sign * 85);
      model.drag(10, sign * 100, 16, { x: 400, y: 300 });
      expect(model.get().headingDeg).toBeLessThan(start.headingDeg);
      expect(model.get().pitchDeg).toBe(sign * 85);
      model.drag(0, -sign, 16, { x: 400, y: 300 });
      expect(Math.abs(model.get().pitchDeg)).toBeLessThan(85);
      expect(Math.abs(model.get().pitchDeg)).toBeGreaterThan(84);
    });

    it("records the clamped pitch displacement for release glide", () => {
      let current: LookSettings = { ...scrollSettings, inertiaHalfLifeMs: 100, reducedMotion: false };
      const model = createLookModel({ ...start, pitchDeg: 84.75 }, () => current, () => {}, () => viewport);
      model.drag(0, 100, 16, { x: 400, y: 300 });
      expect(model.get().pitchDeg).toBe(85);
      model.release();
      // Widening the live limit makes the recorded release speed observable.
      current = { ...current, pitchRangeDeg: { min: -89.9, max: 89.9 } };
      model.step(8);
      expect(model.get().pitchDeg).toBeCloseTo(85.125, 8);
      expect(model.anchor()).toBeNull();
    });

    it("clears an earlier grab, holds still between events and glides at its relative drag speed on release", () => {
      let current: LookSettings = { ...settings, inertiaHalfLifeMs: 100, reducedMotion: false };
      const model = createLookModel({ ...start, headingDeg: 0.1 }, () => current, () => {}, () => viewport);
      model.drag(4, 2, 16, { x: 400, y: 300 });
      expect(model.anchor()).not.toBeNull();
      current = { ...current, dragMode: "scroll" };
      const before = model.get();
      model.drag(12, -5, 16, { x: 400, y: 302 });
      const after = model.get();
      const heading = ((after.headingDeg - before.headingDeg + 540) % 360) - 180;
      const pitch = after.pitchDeg - before.pitchDeg;
      expect(heading).toBeLessThan(0);
      expect(pitch).toBeLessThan(0);
      expect(model.anchor()).toBeNull();
      expect(model.step(32)).toBe(false);
      expect(model.get()).toEqual(after);
      model.release();
      expect(model.moving()).toBe(true);
      model.step(8);
      expect(((model.get().headingDeg - after.headingDeg + 540) % 360) - 180).toBeCloseTo(heading / 2, 8);
      expect(model.get().pitchDeg - after.pitchDeg).toBeCloseTo(pitch / 2, 8);
      expect(model.get().verticalFovDeg).toBe(start.verticalFovDeg);
      expect(model.anchor()).toBeNull();

      const first = model.get();
      model.step(100);
      const second = model.get();
      const firstGlide = ((second.headingDeg - first.headingDeg + 540) % 360) - 180;
      model.step(100);
      const secondGlide = ((model.get().headingDeg - second.headingDeg + 540) % 360) - 180;
      expect(secondGlide).toBeCloseTo(firstGlide / 2, 8);
      expect(model.get().pitchDeg - second.pitchDeg).toBeCloseTo((second.pitchDeg - first.pitchDeg) / 2, 8);
      expect(model.anchor()).toBeNull();
    });

    it.each([
      { name: "a stationary release", stillMs: 81, halfLife: 100, reducedMotion: false },
      { name: "reduced motion", stillMs: 0, halfLife: 100, reducedMotion: true },
      { name: "zero glide half-life", stillMs: 0, halfLife: 0, reducedMotion: false },
    ])("stops immediately with $name", ({ stillMs, halfLife, reducedMotion }) => {
      const current = { ...scrollSettings, inertiaHalfLifeMs: halfLife, reducedMotion };
      const model = createLookModel(start, () => current, () => {}, () => viewport);
      model.drag(10, 4, 16, { x: 400, y: 300 });
      const after = model.get();
      model.release(stillMs);
      expect(model.moving()).toBe(false);
      expect(model.step(100)).toBe(false);
      expect(model.get()).toEqual(after);
      expect(model.anchor()).toBeNull();
    });

    it("keeps a two-touch pinch anchored when one-finger scrolling is selected", () => {
      const model = createLookModel(start, () => scrollSettings, () => {}, () => viewport);
      const from = { mid: { x: 300, y: 280 }, separation: 80 };
      const to = { mid: { x: 360, y: 240 }, separation: 140 };
      const ray = sphereRay(start, viewport, from.mid);
      model.touchPinch(from, to);
      expect(errorAt(model.get(), ray, to.mid)).toBeLessThan(0.25);
      expect(model.anchor()).toMatchObject({ grab: true, zoom: true, held: true });
    });
  });

  it.each([10, 70, 140, 150])("keeps a dragged image under the finger at %s degrees FOV", verticalFovDeg => {
    for (const from of [{ x: 400, y: 300 }, { x: 590, y: 240 }]) {
      const initial = { ...start, verticalFovDeg };
      const model = createLookModel(initial, () => settings, () => {}, () => viewport);
      const ray = sphereRay(initial, viewport, from);
      const to = { x: from.x + 24, y: from.y - 12 };
      model.drag(to.x - from.x, to.y - from.y, 16, from);
      expect(errorAt(model.get(), ray, to)).toBeLessThan(0.25);
      expect(model.get().verticalFovDeg).toBe(verticalFovDeg);
    }
  });

  it("anchors an unspecified drag point at the measured view's centre", () => {
    const initial = { ...start, verticalFovDeg: 10 };
    const model = createLookModel(initial, () => settings, () => {}, () => viewport);
    const from = { x: 400, y: 300 };
    const ray = sphereRay(initial, viewport, from);
    model.drag(35, -14, 16);
    expect(errorAt(model.get(), ray, { x: 435, y: 286 })).toBeLessThan(0.25);
  });

  it("holds the same ray through consecutive drag frames and a heading wrap without drifting while held", () => {
    const initial = { headingDeg: 0.1, pitchDeg: 8, verticalFovDeg: 10 };
    const inertia = { ...settings, inertiaHalfLifeMs: 100, reducedMotion: false };
    const model = createLookModel(initial, () => inertia, () => {}, () => viewport);
    let point = { x: 570, y: 260 };
    const ray = sphereRay(initial, viewport, point);
    for (const delta of [{ x: 14, y: 3 }, { x: 19, y: -4 }, { x: 25, y: 8 }]) {
      model.drag(delta.x, delta.y, 16, point);
      point = { x: point.x + delta.x, y: point.y + delta.y };
      expect(errorAt(model.get(), ray, point)).toBeLessThan(0.25);
      model.step(100);
      expect(errorAt(model.get(), ray, point)).toBeLessThan(0.25);
      expect(model.moving()).toBe(false);
    }
    expect(model.get().headingDeg).toBeGreaterThan(350);
    model.release(100);
    expect(model.step(100)).toBe(false);
    expect(errorAt(model.get(), ray, point)).toBeLessThan(0.25);
  });

  it.each(["drag", "two-touch"] as const)("returns a retained %s grab to its original ray after reaching the pitch limit", kind => {
    const initial = { headingDeg: 42, pitchDeg: 80, verticalFovDeg: 70 };
    const model = createLookModel(initial, () => settings, () => {}, () => viewport);
    const origin = { x: 400, y: 300 };
    const ray = sphereRay(initial, viewport, origin);
    let point = origin;
    const moveTo = (to: typeof origin) => {
      if (kind === "drag") model.drag(to.x - point.x, to.y - point.y, 16, point);
      else model.touchPinch({ mid: point, separation: 100 }, { mid: to, separation: 100 });
      point = to;
    };
    for (const to of [{ x: 400, y: 900 }, { x: 400, y: 1_000 }]) {
      moveTo(to);
      expect(model.get().pitchDeg).toBeLessThanOrEqual(settings.pitchRangeDeg.max);
      expect(model.get().pitchDeg).toBeCloseTo(settings.pitchRangeDeg.max, 5);
      expect(model.get().headingDeg).toBeCloseTo(initial.headingDeg, 5);
    }
    moveTo(origin);
    expect(errorAt(model.get(), ray, origin)).toBeLessThan(0.25);
    expect(model.get().pitchDeg).toBeCloseTo(initial.pitchDeg, 5);
    expect(model.get().headingDeg).toBeCloseTo(initial.headingDeg, 5);
  });

  it("glides a measured short flick through heading zero at its real angular speed", () => {
    const initial = { headingDeg: 0.1, pitchDeg: 0, verticalFovDeg: 10 };
    const inertia = { ...settings, inertiaHalfLifeMs: 100, reducedMotion: false };
    const model = createLookModel(initial, () => inertia, () => {}, () => viewport);
    const headingDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;
    model.drag(20, 0, 16, { x: 400, y: 300 });
    const afterDrag = model.get();
    const dragged = headingDelta(initial.headingDeg, afterDrag.headingDeg);
    expect(afterDrag.headingDeg).toBeGreaterThan(350);
    expect(dragged).toBeLessThan(0);
    model.release();
    expect(model.moving()).toBe(true);
    model.step(8);
    const firstGlide = headingDelta(afterDrag.headingDeg, model.get().headingDeg);
    expect(firstGlide).toBeCloseTo(dragged / 2, 6);
    expect(firstGlide).toBeLessThan(0);
    const afterFirstGlide = model.get();
    model.step(8);
    const secondGlide = headingDelta(afterFirstGlide.headingDeg, model.get().headingDeg);
    expect(secondGlide).toBeLessThan(0);
    expect(Math.abs(secondGlide)).toBeLessThan(Math.abs(firstGlide));
  });

  it.each(["cancel", "release"] as const)("starts a fresh grab after %s clears a grab held against a pitch limit", finish => {
    const model = createLookModel({ headingDeg: 42, pitchDeg: 80, verticalFovDeg: 70 }, () => settings, () => {}, () => viewport);
    const origin = { x: 400, y: 300 }, far = { x: 400, y: 900 };
    model.drag(0, far.y - origin.y, 16, origin);
    if (finish === "cancel") model.cancelInertia();
    else model.release();
    const ray = sphereRay(model.get(), viewport, far);
    const to = { x: far.x, y: far.y - 12 };
    model.drag(0, -12, 16, far);
    expect(errorAt(model.get(), ray, to)).toBeLessThan(0.25);
    expect(model.get().pitchDeg).toBeLessThan(settings.pitchRangeDeg.max);
  });

  it("turns heading and pitch by swipeSensitivity scaled with FOV, glides with map-style inertia, and clamps cleanly at the poles", () => {
    const initial = { headingDeg: 42, pitchDeg: 80, verticalFovDeg: 70 };
    const inertia = { ...settings, inertiaHalfLifeMs: 100, reducedMotion: false };
    const model = createLookModel(initial, () => inertia, () => {}, () => viewport);
    const scale = swipeFovScale(70);
    model.drag(10, 0, 16, { x: 400, y: 300 });
    expect(model.anchor()).not.toBeNull();

    const beforeSwipe = model.get();
    model.swipe(26, -14);
    expect(model.anchor()).toBeNull();
    expect(model.moving()).toBe(true);
    expect(model.get().headingDeg).toBeGreaterThan(beforeSwipe.headingDeg);
    expect(model.get().headingDeg).toBeLessThan(beforeSwipe.headingDeg + 2.6 * scale);
    settle(model);
    expect(model.get().headingDeg).toBeCloseTo(beforeSwipe.headingDeg + 2.6 * scale, 2);
    expect(model.get().pitchDeg).toBeCloseTo(beforeSwipe.pitchDeg + 1.4 * scale, 2);
    expect(model.get().verticalFovDeg).toBe(70);
    expect(model.anchor()).toBeNull();

    // Long swipes into and along the pole clamp pitch and keep turning heading freely.
    for (let step = 0; step < 30; step++) {
      model.swipe(50, -50);
      model.step(FRAME_MS);
    }
    settle(model);
    expect(model.get().pitchDeg).toBe(settings.pitchRangeDeg.max);
    expect(model.get().headingDeg).toBeCloseTo((beforeSwipe.headingDeg + 2.6 * scale + 30 * 5 * scale) % 360, 1);
    expect(model.anchor()).toBeNull();

    // Swiping back down leaves the pole immediately without unwinding excess travel.
    model.swipe(0, 50);
    expect(model.get().pitchDeg).toBeLessThan(settings.pitchRangeDeg.max);
    settle(model);
    expect(model.get().pitchDeg).toBeCloseTo(settings.pitchRangeDeg.max - 5 * scale, 2);
  });

  it("keeps a centre wheel on the old field of view, and an off-centre wheel on the ray under the pointer through inertia", () => {
    let state = start;
    const inertia = { ...settings, inertiaHalfLifeMs: 100, reducedMotion: false };
    const model = createLookModel(start, () => inertia, next => { state = next; }, () => viewport);
    model.wheel(-100, { x: 400, y: 300 });
    expect(model.moving()).toBe(true);
    settle(model);
    expect(state.headingDeg).toBeCloseTo(start.headingDeg, 6);
    expect(state.pitchDeg).toBeCloseTo(start.pitchDeg, 6);
    expect(state.verticalFovDeg).toBeCloseTo(zoomFov(70, settings.zoomPerNotch), 2);

    const beforeOffCentre = state;
    const at = { x: 620, y: 180 };
    const ray = sphereRay(beforeOffCentre, viewport, at);
    model.wheel(-100, at);
    expect(errorAt(state, ray, at)).toBeLessThan(0.25);
    expect(model.moving()).toBe(true);
    while (model.step(FRAME_MS)) {
      expect(errorAt(state, ray, at)).toBeLessThan(0.25);
    }
    expect(state.verticalFovDeg).toBeCloseTo(zoomFov(beforeOffCentre.verticalFovDeg, settings.zoomPerNotch), 2);
  });

  it("moves a two-finger pinch's midpoint and separation as one update", () => {
    let state = start;
    const model = createLookModel(start, () => settings, next => { state = next; }, () => viewport);
    const from = { mid: { x: 300, y: 280 }, separation: 80 };
    const to = { mid: { x: 360, y: 240 }, separation: 140 };
    const ray = sphereRay(start, viewport, from.mid);
    model.touchPinch(from, to);
    expect(state.verticalFovDeg).toBeCloseTo(zoomFov(70, Math.log(140 / 80)), 5);
    expect(errorAt(state, ray, to.mid)).toBeLessThan(0.25);
  });

  it.each([10, 70, 140, 150])("keeps a two-touch midpoint pan anchored across frames at %s degrees FOV", verticalFovDeg => {
    const initial = { ...start, verticalFovDeg };
    const model = createLookModel(initial, () => settings, () => {}, () => viewport);
    let from = { mid: { x: 510, y: 280 }, separation: 100 };
    const ray = sphereRay(initial, viewport, from.mid);
    for (const mid of [{ x: 522, y: 275 }, { x: 538, y: 281 }, { x: 551, y: 288 }]) {
      const to = { mid, separation: 100 };
      model.touchPinch(from, to);
      expect(errorAt(model.get(), ray, mid)).toBeLessThan(0.25);
      expect(model.get().verticalFovDeg).toBe(verticalFovDeg);
      from = to;
    }
  });

  it("still drags by the live sensitivity when no view is measured, and zooms from the centre", () => {
    let state = start;
    const model = createLookModel(start, () => settings, next => { state = next; });
    model.drag(100, 0, 16);
    expect(state.headingDeg).toBeCloseTo(start.headingDeg - 15, 6);
    expect(state.pitchDeg).toBeCloseTo(start.pitchDeg, 6);
    model.wheel(-100, { x: 10, y: 10 });
    expect(state.headingDeg).toBeCloseTo(start.headingDeg - 15, 6);
    expect(state.verticalFovDeg).toBeCloseTo(zoomFov(70, settings.zoomPerNotch), 6);
    const scale = swipeFovScale(state.verticalFovDeg);
    model.swipe(10, -20);
    expect(state.headingDeg).toBeCloseTo(start.headingDeg - 15 + 1 * scale, 6);
    expect(state.pitchDeg).toBeCloseTo(start.pitchDeg + 2 * scale, 6);
  });

  it("uses the same solver for a tab camera, including a measured view", () => {
    let camera: SphereCamera | null = start;
    const target = createSphereCameraTarget({
      get: () => camera,
      set: next => { camera = next; },
      viewport: () => viewport,
      settings: () => settings,
    });
    const at = { x: 180, y: 420 };
    const ray = sphereRay(start, viewport, at);
    target.wheel(-200, at);
    expect(camera).not.toBeNull();
    expect(errorAt(camera!, ray, at)).toBeLessThan(0.25);
    const from = { x: 560, y: 260 };
    const draggedRay = sphereRay(camera!, viewport, from);
    target.drag(18, 20, 16, from);
    expect(errorAt(camera!, draggedRay, { x: 578, y: 280 })).toBeLessThan(0.25);
    target.release();
    const beforeSwipe = camera!;
    const scale = swipeFovScale(beforeSwipe.verticalFovDeg);
    target.swipe(16, -12);
    expect(camera!.headingDeg).toBeCloseTo(beforeSwipe.headingDeg + 1.6 * scale, 6);
    expect(camera!.pitchDeg).toBeCloseTo(beforeSwipe.pitchDeg + 1.2 * scale, 6);
    expect(target.anchor?.()).toBeNull();
  });
});
