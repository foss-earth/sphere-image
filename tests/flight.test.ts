import { describe, expect, it } from "vitest";
import { fovBetween, flightIn, flightMotion, flightOut, flightProgress, flightProgressRate, INSIDE_SHARE, poseView, type FlightPose, handoffReady, orbGeometry } from "../src/index.js";
import { world, enuDirection, enuFrame, geodeticPoint, levelUp, orbitAngles, orbitLook } from "./fixtures/world.js";
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "@foss-earth/images";

const close = (a: Vec3, b: Vec3, digits = 9) => a.forEach((value, index) => expect(value).toBeCloseTo(b[index], digits));
const deg = (value: number) => (value * Math.PI) / 180;
/** Each step's factor over the one before, for `value` at eased progress 0, 0.25, 0.5, 0.75 and 1. */
const steps = (value: (s: number) => number) => [0, 0.25, 0.5, 0.75].map(s => value(s + 0.25) / value(s));
const frame = enuFrame(-93.235, 44.974);
const marker = geodeticPoint(-93.235, 44.974, 262);
const toEcef = (enu: Vec3): Vec3 => add(add(scale(frame.east, enu[0]), scale(frame.north, enu[1])), scale(frame.up, enu[2]));
/** A pose looking at `headingDeg` and `pitchDeg`, rolled `rollDeg` clockwise, at `position`. */
function pose(position: Vec3, headingDeg: number, pitchDeg: number, rollDeg = 0, fovDeg = 60): FlightPose {
  const forward = toEcef(enuDirection(headingDeg, pitchDeg));
  const level = toEcef(enuDirection(headingDeg, pitchDeg + 90));
  const right = normalize(cross(forward, level));
  const roll = (rollDeg * Math.PI) / 180;
  return { position, forward, up: add(scale(level, Math.cos(roll)), scale(right, Math.sin(roll))), verticalFovRad: (fovDeg * Math.PI) / 180 };
}

describe("the flight into an orb", () => {
  // 200 m south-west of the orb and 80 m above it, looking north and down, the orb off centre.
  const start = pose(add(marker, toEcef([-150, -130, 80])), 10, -25, 0.4);
  const radius = 6;
  const flight = flightIn(world, start, marker, radius)!;

  it("starts exactly at the camera's view", () => {
    const first = flight.pose(0);
    close(first.position, start.position, 6);
    close(first.forward, start.forward);
    close(first.up, start.up);
  });

  it("ends inside the orb facing the marker, level about its vertical, where the image can take over", () => {
    const last = flight.pose(1);
    const rel = sub(marker, last.position);
    expect(length(rel)).toBeCloseTo(radius * INSIDE_SHARE, 6);
    close(last.forward, normalize(rel));
    close(last.up, levelUp(last.forward, normalize(marker), start.up));
    expect(handoffReady(orbGeometry(rel, radius), poseView(last, 1.6), Math.PI / 4)).toBe(true);
  });

  it("closes in by the same factor each step, so the orb grows at a steady rate", () => {
    const distance = (s: number) => length(sub(marker, flight.pose(s).position));
    const ratios = [0, 0.25, 0.5, 0.75].map(s => distance(s + 0.25) / distance(s));
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0], 9);
    expect(ratios[0]).toBeLessThan(1);
  });

  it("does not fly from inside the orb", () => {
    expect(flightIn(world, pose(add(marker, toEcef([2, 0, 0])), 0, 0), marker, radius)).toBeNull();
  });

  it("keeps the camera's field of view, and the orb its size, unless asked", () => {
    for (const s of [0, 0.3, 1]) {
      expect(flight.pose(s).verticalFovRad).toBe(start.verticalFovRad);
      expect(flight.radius(s)).toBe(radius);
    }
  });

  it("widens to the image's field of view on the way, by a steady factor in the tangent of its half angle", () => {
    const wide = flightIn(world, start, marker, radius, { verticalFovRad: deg(120) })!;
    expect(wide.pose(0).verticalFovRad).toBe(start.verticalFovRad);
    expect(wide.pose(1).verticalFovRad).toBe(deg(120));
    const factors = steps(s => Math.tan(wide.pose(s).verticalFovRad / 2));
    for (const factor of factors) expect(factor).toBeCloseTo(factors[0], 9);
    expect(factors[0]).toBeGreaterThan(1);
    // Where it goes and where it looks are the flight's own.
    for (const s of [0.4, 1]) {
      close(wide.pose(s).position, flight.pose(s).position, 6);
      close(wide.pose(s).forward, flight.pose(s).forward);
    }
  });

  it("grows the orb by its share of the closing while the camera flies the rest, ending inside it", () => {
    const distance = length(sub(marker, start.position));
    const ratio = distance / (radius * INSIDE_SHARE);
    const growing = flightIn(world, start, marker, radius, { growth: 0.5 })!;
    const away = (s: number) => length(sub(marker, growing.pose(s).position));
    expect(growing.radius(0)).toBe(radius);
    expect(growing.radius(1)).toBeCloseTo(radius * Math.sqrt(ratio), 9);
    expect(away(0)).toBeCloseTo(distance, 6);
    expect(away(1)).toBeCloseTo(growing.radius(1) * INSIDE_SHARE, 6);
    // The orb's size on screen, radius over distance, grows as steadily as without growth.
    const sizes = steps(s => growing.radius(s) / away(s));
    const without = steps(s => radius / length(sub(marker, flight.pose(s).position)));
    for (const [index, size] of sizes.entries()) expect(size).toBeCloseTo(without[index], 9);
    const last = growing.pose(1);
    expect(handoffReady(orbGeometry(sub(marker, last.position), growing.radius(1)), poseView(last, 1.6), Math.PI / 4)).toBe(true);
  });

  it("grows the orb the whole way around a camera that only turns", () => {
    const growing = flightIn(world, start, marker, radius, { growth: 1 })!;
    const distance = length(sub(marker, start.position));
    for (const s of [0, 0.5, 1]) expect(length(sub(marker, growing.pose(s).position))).toBeCloseTo(distance, 6);
    expect(growing.radius(1) * INSIDE_SHARE).toBeCloseTo(distance, 6);
  });

  it("knows when the eye passes through the orb's surface", () => {
    for (const growth of [0, 0.5, 1]) {
      const each = flightIn(world, start, marker, radius, { growth })!;
      expect(length(sub(marker, each.pose(each.surface).position))).toBeCloseTo(each.radius(each.surface), 6);
      expect(each.surface).toBeGreaterThan(0.9);
      expect(each.surface).toBeLessThan(1);
    }
  });
});

describe("the flight out of an orb", () => {
  // The overview the sphere was entered from: 600 m out, 40° down from the horizon, a 45° view.
  const overview = { center: { x: 0, y: 0, z: 0 }, yaw: 0.3, pitch: Math.PI / 2 - (40 * Math.PI) / 180, radius: 600, fov: Math.PI / 4 };
  const start = pose(marker, 250, 12, 3, 75);
  const radius = 4;
  const flight = flightOut(world, start, marker, radius, overview)!;

  it("starts inside the orb with the image's own view, so the orb can take over from it", () => {
    const first = flight.pose(0);
    const rel = sub(marker, first.position);
    expect(length(rel)).toBeCloseTo(radius * INSIDE_SHARE, 9);
    close(first.forward, start.forward);
    close(first.up, start.up);
    expect(first.verticalFovRad).toBeCloseTo(start.verticalFovRad, 12);
    expect(handoffReady(orbGeometry(rel, radius), poseView(first, 1.6), Math.PI / 4)).toBe(true);
  });

  it("backs away keeping the heading, always looking at the marker", () => {
    const heading = orbitAngles(marker, start.forward, 0).yaw;
    for (const s of [0.2, 0.5, 0.8, 1]) {
      const each = flight.pose(s);
      close(each.forward, normalize(sub(marker, each.position)));
      expect(orbitAngles(marker, each.forward, 0).yaw).toBeCloseTo(heading, 9);
    }
  });

  it("ends as the globe camera's own orbit view of the marker, at the overview's pitch, distance and field of view", () => {
    const last = flight.pose(1);
    const { camera } = flight.end;
    close([camera.center.x, camera.center.y, camera.center.z], marker);
    expect(camera).toMatchObject({ pitch: overview.pitch, radius: 600, fov: overview.fov });
    const look = orbitLook(marker, camera.yaw, camera.pitch);
    close(last.forward, look);
    close(last.position, sub(marker, scale(look, 600)), 6);
    close(last.up, levelUp(look, normalize(marker), start.up));
    expect(last.verticalFovRad).toBeCloseTo(overview.fov, 12);
    expect(flight.end.view).toMatchObject({ pitchDeg: expect.closeTo(40, 9), zoomMeters: 600 });
  });

  it("does not fly to a view inside the orb", () => {
    expect(flightOut(world, start, marker, 700, overview)).toBeNull();
  });

  it("narrows to the overview's field of view by a steady factor in the tangent of its half angle", () => {
    const factors = steps(s => Math.tan(flight.pose(s).verticalFovRad / 2));
    for (const factor of factors) expect(factor).toBeCloseTo(factors[0], 9);
    expect(factors[0]).toBeLessThan(1);
  });

  it("starts inside an orb grown by its share of the closing and shrinks it back to its own size", () => {
    const ratio = overview.radius / (radius * INSIDE_SHARE);
    const shrinking = flightOut(world, start, marker, radius, overview, { growth: 0.5 })!;
    const away = (s: number) => length(sub(marker, shrinking.pose(s).position));
    expect(shrinking.radius(0)).toBeCloseTo(radius * Math.sqrt(ratio), 9);
    expect(away(0)).toBeCloseTo(shrinking.radius(0) * INSIDE_SHARE, 9);
    expect(shrinking.radius(1)).toBeCloseTo(radius, 9);
    expect(away(1)).toBeCloseTo(overview.radius, 6);
    const first = shrinking.pose(0);
    close(first.forward, start.forward);
    expect(handoffReady(orbGeometry(sub(marker, first.position), shrinking.radius(0)), poseView(first, 1.6), Math.PI / 4)).toBe(true);
    expect(away(shrinking.surface)).toBeCloseTo(shrinking.radius(shrinking.surface), 6);
    expect(shrinking.surface).toBeLessThan(0.05);
    close(shrinking.pose(1).position, flight.pose(1).position, 6);
  });
});

describe("a flight's pace", () => {
  it("leaves at once and lands exactly", () => {
    expect(flightProgress(0)).toBe(0);
    expect(flightProgress(1)).toBe(1);
    expect(flightProgress(-1)).toBe(0);
    expect(flightProgress(2)).toBe(1);
    // A twentieth of the way through it has gone over five times as far as a smooth step would have.
    expect(flightProgress(0.05)).toBeGreaterThan(5 * 0.05 * 0.05 * (3 - 2 * 0.05));
  });

  it("is fastest an eighth of the way through and settles slowly onto its goal", () => {
    const peak = flightProgressRate(1 / 8);
    for (const t of [0, 0.05, 0.1, 0.15, 0.3, 0.6, 1]) expect(flightProgressRate(t)).toBeLessThan(peak);
    expect(flightProgress(0.5)).toBeGreaterThan(0.9);
    expect(flightProgressRate(1)).toBeLessThan(peak / 100);
    for (let t = 0; t < 1; t += 0.05) expect(flightProgress(t + 0.05)).toBeGreaterThan(flightProgress(t));
  });

  it("grows at the rate it gives", () => {
    for (const t of [0.01, 0.125, 0.4, 0.9]) {
      const h = 1e-6;
      expect(flightProgressRate(t)).toBeCloseTo((flightProgress(t + h) - flightProgress(t - h)) / (2 * h), 6);
    }
  });
});

describe("a field of view part way", () => {
  it("is exact at both ends and the same when there is nothing to change", () => {
    expect(fovBetween(deg(60), deg(120), 0)).toBe(deg(60));
    expect(fovBetween(deg(60), deg(120), 1)).toBe(deg(120));
    expect(fovBetween(deg(75), deg(75), 0.4)).toBe(deg(75));
    expect(Math.tan(fovBetween(deg(60), deg(120), 0.5) / 2)).toBeCloseTo(1, 12);
  });
});

describe("a flight cut short", () => {
  const overview = { center: { x: 0, y: 0, z: 0 }, yaw: 0.3, pitch: Math.PI / 2 - (40 * Math.PI) / 180, radius: 600, fov: Math.PI / 4 };
  const out = flightOut(world, pose(marker, 250, 20, 3, 75), marker, 4, overview)!;
  const into = flightIn(world, pose(add(marker, toEcef([-150, -130, 80])), 10, -25, 0.4), marker, 6)!;

  it("moves as fast as the flight was moving where it got to", () => {
    for (const [flight, s] of [[out, 0.2], [into, 0.6], [out, 0], [into, 1]] as const) {
      const rate = 1.3;
      const { velocity, turn } = flightMotion(flight, s, rate);
      // Over a small step of time, the flight moves by the velocity and turns by the turn.
      const dt = 1e-5;
      const ahead = flight.pose(Math.min(1, s + rate * dt));
      const here = flight.pose(Math.min(1, s + rate * dt) - rate * dt);
      close(add(here.position, scale(velocity, dt)), ahead.position, 4);
      close(add(here.forward, scale(turn, dt)), ahead.forward, 8);
    }
    // Out, away from the orb; in, toward it.
    expect(dot(flightMotion(out, 0.2, 1).velocity, sub(out.pose(0.2).position, marker))).toBeGreaterThan(0);
    expect(dot(flightMotion(into, 0.6, 1).velocity, sub(marker, into.pose(0.6).position))).toBeGreaterThan(0);
  });

});
