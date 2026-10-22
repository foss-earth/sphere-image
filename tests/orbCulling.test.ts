import { Matrix } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { orbQuadOutsideView } from "../src/renderer.js";
import type { Vec3 } from "@foss-earth/images";

type Quad = Parameters<typeof orbQuadOutsideView>[0];
const quad = (center: Vec3, u: Vec3 = [0.1, 0, 0], v: Vec3 = [0, 0.1, 0]): Quad => ({ center, u, v, fullscreen: false });

// Independent corner oracle, rounding each shader operation to float32.
function outsideInShader(q: Quad, matrix: Matrix): boolean {
  const f = Math.fround, m = matrix.m;
  const corners = [-1, 1].flatMap(s => [-1, 1].map(t => {
    const p = q.center.map((c, axis) => f(f(f(c) + s * f(q.u[axis])) + t * f(q.v[axis])));
    return [0, 1, 3].map(axis => f(f(f(f(p[0] * m[axis]) + f(p[1] * m[axis + 4])) + f(p[2] * m[axis + 8])) + m[axis + 12]));
  }));
  return [
    ([x, , w]: number[]) => x > w,
    ([x, , w]: number[]) => x < -w,
    ([, y, w]: number[]) => y > w,
    ([, y, w]: number[]) => y < -w,
    ([, , w]: number[]) => w < 0,
  ].some(plane => corners.every(plane));
}

describe("analytic orb clip rejection", () => {
  it("rejects all four side planes, retains intersecting edges, outlines and full-screen quads", () => {
    const m = Matrix.Identity();
    for (const center of [[2, 0, 0], [-2, 0, 0], [0, 2, 0], [0, -2, 0]] as Vec3[]) {
      expect(orbQuadOutsideView(quad(center), m)).toBe(true);
      expect(orbQuadOutsideView(quad(center, [2, 0, 0], [0, 2, 0]), m)).toBe(false);
    }
    expect(orbQuadOutsideView(quad([1.1, 0, 0]), m)).toBe(false);
    expect(orbQuadOutsideView(quad([1.10001, 0, 0]), m)).toBe(false);
    expect(orbQuadOutsideView({ ...quad([2, 0, 0]), fullscreen: true }, m)).toBe(false);
    m.m[15] = -1;
    expect(orbQuadOutsideView(quad([0, 0, 0]), m)).toBe(true);
    expect(orbQuadOutsideView(quad([NaN, 0, 0]), m)).toBe(false);
    expect(orbQuadOutsideView(quad([Infinity, 0, 0]), m)).toBe(false);
  });

  it("never rejects a shader-visible corner across seeded scales, cancellation and projections", () => {
    let seed = 0x41534;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const vector = (scale: number): Vec3 => [(random() - 0.5) * scale, (random() - 0.5) * scale, (random() - 0.5) * scale];
    let rejected = 0;
    for (let index = 0; index < 30000; index++) {
      const scale = 10 ** (random() * 16 - 8);
      const q = quad(vector(scale), vector(scale * random()), vector(scale * random()));
      const m = Matrix.FromArray(Array.from({ length: 16 }, () => (random() - 0.5) * 4));
      // Translations that nearly cancel the centre exercise the slack bound.
      if (index % 2 === 0) for (const axis of [0, 1, 3]) {
        m.m[axis + 12] = -(q.center[0] * m.m[axis] + q.center[1] * m.m[axis + 4] + q.center[2] * m.m[axis + 8]) * (1 + 1e-6 * random());
      }
      if (orbQuadOutsideView(q, m)) {
        rejected++;
        if (!outsideInShader(q, m)) expect.fail(`shader-visible quad rejected in case ${index}`);
      }
    }
    expect(rejected).toBeGreaterThan(2000);
  });
});
