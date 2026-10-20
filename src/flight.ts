/** Retained orb entry/exit paths; world math supplied by the host. */
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "@foss-earth/images";
import type { ViewBasis } from "./math.js";
import type { ViewerWorldMath, ViewerNavigationSnapshot } from "./ports.js";
const RAD_TO_DEG = 180 / Math.PI;
export interface FlightPose {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
  verticalFovRad: number;
}

export interface Flight {
  /** The radius the orb draws with at eased progress `s`, metres: it grows on the way in and shrinks on the way out. */
  radius(s: number): number;
  /** The eased progress at which the eye passes through the orb's surface. */
  surface: number;
  /** The pose at eased progress `s`, from 0 to 1. */
  pose(s: number): FlightPose;
}

/**
 * How much of a flight's closing the orb makes. An orb's size on screen
 * follows its radius over the eye's distance, and a flight changes that ratio
 * by the same factor each moment; this share of the change, by its
 * logarithm, comes from the orb growing on the way in or shrinking on the way
 * out, and the rest from the camera's travel. 0 flies the whole way to an orb
 * that keeps its size; 1 grows the orb around a camera that only turns.
 */
export const FLIGHT_GROWTH = 0.5;

/**
 * How stiff the spring that paces a flight is: its angular frequency times
 * the flight's duration. The flight is fastest an eighth of the way through,
 * and lands at under a hundredth of that speed.
 */
const STIFFNESS = 8;
const spring = (t: number): number => 1 - (1 + STIFFNESS * t) * Math.exp(-STIFFNESS * t);
const SPRUNG = spring(1);

/**
 * Eased progress `t` of the way through a flight's duration: a critically
 * damped spring let go from rest, as a phone opens an app. It moves at once,
 * is fastest early and settles slowly onto its goal, landing exactly at 1.
 */
export function flightProgress(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : spring(t) / SPRUNG;
}

/** How fast `flightProgress` grows at `t`, in progress per duration. */
export function flightProgressRate(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return (STIFFNESS * STIFFNESS * u * Math.exp(-STIFFNESS * u)) / SPRUNG;
}

/**
 * How far inside the orb a flight ends or starts, as a share of its radius.
 * Inside, every ray is covered and the image looks the same from anywhere,
 * so the camera's travel there cannot be seen: just inside the surface keeps
 * that unseen stretch to a few hundredths of the flight.
 */
export const INSIDE_SHARE = 0.9;

/** The signed angle about the unit `axis` that turns `from` to `to`, both across it, radians. */
function angleAbout(from: Vec3, to: Vec3, axis: Vec3): number {
  return Math.atan2(dot(cross(from, to), axis), dot(from, to));
}

/** `v`, across the unit `axis`, turned about it by `angle` radians. */
function turnAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  return add(scale(v, Math.cos(angle)), scale(cross(axis, v), Math.sin(angle)));
}

/** Part way along the great circle from `a` to `b`; opposite directions turn about `pivot`. */
function slerp(a: Vec3, b: Vec3, s: number, pivot: Vec3): Vec3 {
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  if (angle < 1e-9) return normalize(add(scale(a, 1 - s), scale(b, s)));
  let axis = cross(a, b);
  if (length(axis) < 1e-9) axis = sub(pivot, scale(a, dot(pivot, a)));
  return normalize(turnAbout(a, normalize(axis), angle * s));
}

/** Distance part way from `from` to `to` by the same factor each moment: steady growth on screen. */
const geometric = (from: number, to: number, s: number): number => from * Math.pow(to / from, s);

/**
 * A vertical field of view part way from `from` to `to`, radians, its half
 * angle's tangent changing by the same factor each moment: a steady zoom on
 * screen, which joins the distance's steady growth as one motion. Exact at
 * both ends.
 */
export function fovBetween(from: number, to: number, s: number): number {
  if (s <= 0 || from === to) return from;
  if (s >= 1) return to;
  return 2 * Math.atan(geometric(Math.tan(from / 2), Math.tan(to / 2), s));
}

/** A pose's view for the coverage tests, with the viewport's aspect. */
export function poseView(pose: FlightPose, aspect: number): ViewBasis {
  return { forward: pose.forward, up: pose.up, right: normalize(cross(pose.forward, pose.up)), verticalFovRad: pose.verticalFovRad, aspect };
}

/** The radius an orb of `radiusMeters` grows or shrinks to, so that its size on screen changes by `ratio` with `growth` of it its own. */
const grownRadius = (radiusMeters: number, ratio: number, growth: number): number => radiusMeters * Math.pow(ratio, Math.min(1, Math.max(0, growth)));

/**
 * Into an orb from where the camera is: straight at its marker while turning
 * to face it, until the eye is `INSIDE_SHARE` of the radius inside the orb,
 * which grows from `radiusMeters` on the way by `growth` (see
 * `FLIGHT_GROWTH`). The roll the view starts with, relative to level, unwinds
 * on the way, and the field of view widens or narrows to `verticalFovRad`, so
 * the flight arrives with the image's own view. Null when the eye is already
 * inside the orb.
 */
export function flightIn(world: ViewerWorldMath, start: FlightPose, marker: Vec3, radiusMeters: number, options: { verticalFovRad?: number; growth?: number } = {}): Flight | null {
  const rel = sub(marker, start.position);
  const distance = length(rel);
  if (!(radiusMeters > 0) || !(distance > radiusMeters)) return null;
  const axis = scale(rel, 1 / distance);
  const vertical = normalize(marker);
  const roll = angleAbout(world.levelUp(start.forward, vertical, start.up), start.up, start.forward);
  const endFov = options.verticalFovRad ?? start.verticalFovRad;
  // How much larger the orb looks at the end than at the start.
  const ratio = distance / (radiusMeters * INSIDE_SHARE);
  const grown = grownRadius(radiusMeters, ratio, options.growth ?? 0);
  const near = grown * INSIDE_SHARE;
  return {
    radius: s => geometric(radiusMeters, grown, s),
    surface: Math.log(distance / radiusMeters) / Math.log(ratio),
    pose(s) {
      const forward = slerp(start.forward, axis, s, start.up);
      return {
        position: sub(marker, scale(axis, geometric(distance, near, s))),
        forward,
        up: turnAbout(world.levelUp(forward, vertical, start.up), forward, roll * (1 - s)),
        verticalFovRad: fovBetween(start.verticalFovRad, endFov, s),
      };
    },
  };
}

/**
 * Out of an orb, backing away from the way the view faces: from
 * `INSIDE_SHARE` of the radius inside the orb to the view that keeps the
 * heading and looks at the marker with the saved overview's pitch, distance
 * and field of view, while the orb shrinks back to `radiusMeters` by `growth`
 * (see `FLIGHT_GROWTH`). `end` is that view as the globe camera's snapshot,
 * centred on the marker. The view's roll unwinds on the way. Null when that
 * view would be inside the orb.
 */
export function flightOut(world: ViewerWorldMath, start: Omit<FlightPose, "position">, marker: Vec3, radiusMeters: number, overview: ViewerNavigationSnapshot["camera"], options: { growth?: number } = {}): (Flight & { end: ViewerNavigationSnapshot }) | null {
  const far = overview.radius;
  if (!(radiusMeters > 0) || !(far > radiusMeters)) return null;
  const vertical = normalize(marker);
  const { yaw, pitch } = world.orbitAngles(marker, start.forward, overview.yaw);
  const roll = angleAbout(world.levelUp(start.forward, vertical, start.up), start.up, start.forward);
  // How much smaller the orb looks at the end than at the start.
  const ratio = far / (radiusMeters * INSIDE_SHARE);
  const grown = grownRadius(radiusMeters, ratio, options.growth ?? 0);
  const near = grown * INSIDE_SHARE;
  const place = world.pointGeodetic(marker);
  return {
    radius: s => geometric(grown, radiusMeters, s),
    surface: Math.log(1 / INSIDE_SHARE) / Math.log(ratio),
    pose(s) {
      const forward = world.orbitLook(marker, yaw, pitch + (overview.pitch - pitch) * s);
      return {
        position: sub(marker, scale(forward, geometric(near, far, s))),
        forward,
        up: turnAbout(world.levelUp(forward, vertical, start.up), forward, roll * (1 - s)),
        verticalFovRad: fovBetween(start.verticalFovRad, overview.fov, s),
      };
    },
    end: {
      version: 1,
      view: {
        latDeg: place.latitudeDeg,
        lonDeg: place.longitudeDeg,
        headingDeg: (((yaw * RAD_TO_DEG) % 360) + 360) % 360,
        pitchDeg: 90 * (1 - (2 * overview.pitch) / Math.PI),
        zoomMeters: far,
      },
      camera: { center: { x: marker[0], y: marker[1], z: marker[2] }, yaw, pitch: overview.pitch, radius: far, fov: overview.fov },
    },
  };
}

/** How far either side of a pose, in eased progress, a flight's motion is measured. */
const MOTION_PROBE = 1e-4;

/**
 * How fast a flight moves at eased progress `s`, going at `rate` progress
 * per second: its eye's velocity, m/s, and how fast its look turns (the
 * look's derivative), 1/s.
 */
export function flightMotion(flight: Flight, s: number, rate: number): { velocity: Vec3; turn: Vec3 } {
  const from = Math.max(0, s - MOTION_PROBE);
  const to = Math.min(1, s + MOTION_PROBE);
  const a = flight.pose(from);
  const b = flight.pose(to);
  const per = rate / (to - from);
  return { velocity: scale(sub(b.position, a.position), per), turn: scale(sub(b.forward, a.forward), per) };
}

