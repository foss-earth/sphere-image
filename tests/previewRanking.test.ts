import { describe, expect, it } from "vitest";
import { previewFaceTexels } from "@foss-earth/sphere-cubemap/core";
import type { ImageRepresentation } from "@foss-earth/images";
import { chooseRepresentation, createBuiltInRepresentations, createViewerSelection, type ViewerRepresentation, type ViewerSelectionParameters, type ViewerSelectionPorts } from "../src/index.js";
import type { ViewerImageInput } from "../src/ports.js";
import { image } from "./fixtures/viewer.js";

// The preview choice as it was before previews were ranked once per asset,
// kept verbatim as the reference the ranked choice must match.
function referenceChoose<R extends ImageRepresentation>(
  representations: readonly R[], role: R["role"] | "any", wantedFaceTexels: number,
  registry: readonly ViewerRepresentation<R>[], context: { maxTextureSide: number },
  admissible: (representation: R) => string | null,
) {
  const plugin = (record: R): ViewerRepresentation<R> => {
    const result = registry.find(entry => entry.hooks.projection === record.projection);
    if (!result) throw new Error(`No representation hook for ${record.projection}.`);
    return result;
  };
  const density = (record: R): number => plugin(record).faceTexels(record);
  const estimateErrors = new Map<R, string>();
  const gpuBytes = (record: R): number => {
    try { return plugin(record).hooks.estimate(record, context).sourceGpu; }
    catch (error) { estimateErrors.set(record, error instanceof Error ? error.message : String(error)); return Number.POSITIVE_INFINITY; }
  };
  const candidates = representations.filter(entry => role === "any" || entry.role === role)
    .sort((a, b) => density(a) - density(b) || gpuBytes(a) - gpuBytes(b));
  const refusals: { representation: R; reason: string }[] = [];
  let best: R | null = null;
  for (const candidate of candidates) {
    gpuBytes(candidate);
    const refusal = estimateErrors.get(candidate) ?? admissible(candidate);
    if (refusal) {
      refusals.push({ representation: candidate, reason: refusal });
      if (density(candidate) >= wantedFaceTexels) break;
      continue;
    }
    best = candidate;
    if (density(candidate) >= wantedFaceTexels) return { representation: candidate, limitation: null, next: null };
  }
  if (!best) return null;
  const chosen = best;
  const larger = candidates.filter(entry => density(entry) > density(chosen));
  const next = refusals.find(refusal => density(refusal.representation) > density(chosen)) ?? null;
  const limitation = larger.length === 0
    ? `the largest available is ${Math.round(density(chosen))} texels per face, below the ${Math.round(wantedFaceTexels)} asked for`
    : `a larger representation does not fit: ${refusals.map(refusal => `${refusal.representation.id}: ${refusal.reason}`).join("; ")}`;
  return { representation: chosen, limitation, next };
}
function referencePreview(ports: ViewerSelectionPorts, input: ViewerImageInput, diameter: number | null) {
  const density=(record:ImageRepresentation):number=>{
    const owner=ports.representations.find(entry=>entry.hooks.projection===record.projection);
    if(!owner)throw new Error(`No public density hook for ${record.projection}.`);
    return owner.faceTexels(record);
  };
  const p=ports.parameters(),previews=input.asset.representations.filter(record=>record.role==="preview"&&record.projection==="cube");
  const inRange=previews.filter(record=>density(record)>=p.previewFaces.min&&density(record)<=p.previewFaces.max);
  const wanted=diameter===null?p.previewFaces.min:previewFaceTexels(diameter,p.previewFovDeg*Math.PI/360,p.previewDensity);
  const choice=referenceChoose(inRange.length?inRange:previews,"preview",Math.min(Math.max(wanted,p.previewFaces.min),p.previewFaces.max),ports.representations,{maxTextureSide:ports.maxTextureSide()},record=>ports.current(input).preview===record.id?null:ports.admissible(record,false));
  if(!choice)return null;
  const range=inRange.length?null:`no preview is within ${p.previewFaces.min}–${p.previewFaces.max} px (scene.panorama.previewFaceRange)`;
  return {representation:choice.representation,limitation:[range,choice.limitation].filter(Boolean).join("; ")||null};
}

const registry = createBuiltInRepresentations(() => ({ tileMemoryBytes: 1024 * 1024, responseBytes: 1024, requests: 1, waiting: 1, uploadOutstandingBytes: 1024 * 1024 })) as unknown as readonly ViewerRepresentation[];
function random(seed: number): () => number {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const deepFreeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; };
const cube = (id: string, faceSize: number, role: "preview" | "immersion", encodedBytes: number) => ({ id, role, projection: "cube", mimeType: "image/png", encodedBytes, faceSize,
  faces: Object.fromEntries(["px", "nx", "py", "ny", "pz", "nz"].map(face => [face, `https://fixture.invalid/${id}/${face}.png`])) }) as unknown as ImageRepresentation;
const tiled = (id: string, faceSize: number) => ({ id, role: "immersion", projection: "tiled-cube", mimeType: "image/png", encodedBytes: 60, faceSize, warp: "gnomonic", tileSize: 2, gutter: 0, levelBytes: [6, 24, 96], url: `https://fixture.invalid/${id}/` }) as unknown as ImageRepresentation;
const equirect = (id: string, width: number) => ({ id, role: "preview", projection: "equirectangular", mimeType: "image/jpeg", encodedBytes: 60, width, height: width / 2, url: `https://fixture.invalid/${id}.jpg` }) as unknown as ImageRepresentation;

describe("ranked preview choice", () => {
  it("chooses, limits and asks admission exactly as the unranked choice did", () => {
    const sizes = [16, 48, 64, 64, 96, 128, 200, 256, 512, 1024, 4096, 8192], ranges = [{ min: 64, max: 256 }, { min: 128, max: 256 }, { min: 32, max: 128 }, { min: 300, max: 400 }, { min: 64, max: 64 }];
    let compared = 0, cached = 0; const chosen = new Set<string>();
    for (let trial = 0; trial < 400; trial += 1) {
      const next = random(trial + 1), pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const representations = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, index) =>
        next() < 0.15 ? equirect(`e${index}`, 2 * pick(sizes)) : cube(`c${index}`, pick(sizes), next() < 0.8 ? "preview" : "immersion", 60));
      const input = image(); input.asset = { ...input.asset, representations };
      const frozen = next() < 0.75; if (frozen) deepFreeze(input);
      let parameters: ViewerSelectionParameters = { previewFaces: ranges[0]!, previewFovDeg: 90, previewDensity: 1, immersionWidth: 4096, immersionDensity: null, preference: "whole" };
      let maxTextureSide = 4096, shown: string | null = null, refusing = new Set<string>(), calls: string[] = [];
      const ports: ViewerSelectionPorts = { representations: registry, parameters: () => parameters, maxTextureSide: () => maxTextureSide, viewportHeightDevicePx: () => 900,
        current: () => ({ preview: shown, shown: null }), imageName: record => record.id,
        admissible: (record, overlap) => { calls.push(`${record.id} ${overlap}`); return refusing.has(record.id) ? `${record.id} does not fit` : null; } };
      const selection = createViewerSelection(ports);
      for (let call = 0; call < 25; call += 1) {
        if (next() < 0.2) parameters = { ...parameters, previewFaces: pick(ranges), previewFovDeg: pick([60, 90]), previewDensity: pick([0.5, 1, 2]) };
        if (next() < 0.1) maxTextureSide = pick([2048, 4096, 16384]);
        shown = next() < 0.5 ? null : pick(representations).id;
        refusing = new Set(representations.filter(() => next() < 0.3).map(record => record.id));
        const diameter = pick([null, 0, Infinity, next() * 2000]);
        calls = []; const expected = referencePreview(ports, input, diameter), expectedCalls = calls;
        calls = []; const actual = selection.preview(input, diameter);
        expect(actual).toEqual(expected); expect(actual?.representation ?? null).toBe(expected?.representation ?? null); expect(calls).toEqual(expectedCalls);
        compared += 1; if (frozen) cached += 1; if (actual) chosen.add(actual.limitation ? "limited" : "met");
      }
    }
    expect(compared).toBe(10_000); expect(cached).toBeGreaterThan(5000); expect([...chosen].sort()).toEqual(["limited", "met"]);
  });
  it("ranks mixed representations for any role exactly as before", () => {
    const sizes = [16, 64, 64, 128, 256, 1024, 4096, 8192];
    for (let trial = 0; trial < 2000; trial += 1) {
      const next = random(10_000 + trial), pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const representations = Array.from({ length: 1 + Math.floor(next() * 7) }, (_, index) => {
        const kind = next(), size = pick(sizes);
        return kind < 0.3 ? equirect(`e${index}`, 4 * size) : kind < 0.45 ? tiled(`t${index}`, size) : cube(`c${index}`, size, next() < 0.5 ? "preview" : "immersion", 60);
      });
      const role = pick(["any", "preview", "immersion"] as const), wanted = pick([0, 64, 200, 1024, Infinity]), context = { maxTextureSide: pick([2048, 4096, 16384]) };
      const refusing = new Set(representations.filter(() => next() < 0.3).map(record => record.id));
      let calls: string[] = [];
      const admissible = (record: ImageRepresentation) => { calls.push(record.id); return refusing.has(record.id) ? `${record.id} refused` : null; };
      const expected = referenceChoose(representations, role, wanted, registry, context, admissible), expectedCalls = calls;
      calls = []; const actual = chooseRepresentation(representations, role, wanted, registry, context, admissible);
      expect(actual).toEqual(expected); expect(calls).toEqual(expectedCalls);
    }
  });
  it("keeps an unfrozen asset's ranking out of the cache, so an edited record is seen", () => {
    const record = cube("p", 64, "preview", 60) as unknown as { faceSize: number }, input = image();
    input.asset = { ...input.asset, representations: [record as unknown as ImageRepresentation, cube("q", 128, "preview", 60)] };
    let wantedFaces = { min: 64, max: 256 };
    const selection = createViewerSelection({ representations: registry, parameters: () => ({ previewFaces: wantedFaces, previewFovDeg: 90, previewDensity: 1, immersionWidth: 4096, immersionDensity: null, preference: "whole" }),
      maxTextureSide: () => 4096, viewportHeightDevicePx: () => 900, current: () => ({ preview: null, shown: null }), admissible: () => null, imageName: entry => entry.id });
    expect(selection.preview(input, null)?.representation.id).toBe("p");
    record.faceSize = 256; wantedFaces = { min: 64, max: 256 };
    expect(selection.preview(input, null)?.representation.id).toBe("q");
  });
});
