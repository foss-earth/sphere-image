import { BaseTexture, FreeCamera, Matrix, NullEngine, Scene, ShaderLanguage, ShaderMaterial, Vector3, Vector4, Viewport } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dot, length, normalize, type Mat3, type Vec3 } from "@foss-earth/images";
import { createSphereRenderer, imageFromClipMatrix, orbDrawConstants, orbQuad, type SphereRendererExperiments, type SphereRendererOptions } from "../src/renderer.js";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function setup(configure: (engine: NullEngine) => void = () => {}, experiments: Partial<SphereRendererExperiments> = {}, extra: Partial<SphereRendererOptions> = {}) {
  const engine = new NullEngine();
  configure(engine);
  engines.push(engine);
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const requestRender = vi.fn();
  const onError = vi.fn();
  const renderer = createSphereRenderer(scene, { getCamera: () => camera, viewportHeightCssPx: () => engine.getRenderHeight(), presentationLayerMask: 0x10000000, appearance: { previewFovDeg: 90, markerDiameterCssPx: { min: 24, max: 96 }, hitTargetDiameterCssPx: 44 }, getPresentationView: () => null, requestRender, onError, experiments, ...extra });
  return { camera, renderer, engine, scene, requestRender, onError };
}

describe("sphere renderer backends", () => {
  const content: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const version of [1, 2]) it(`draws analytic orbs and immersion with GLSL on WebGL ${version}`, () => {
    const { renderer, scene } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true, textureLOD: false });
      Object.defineProperty(engine, "webGLVersion", { value: version });
    });
    expect(renderer.available).toBe(true);
    expect(renderer.unavailableReason).toBeNull();
    const texture = new BaseTexture(scene);
    renderer.addOrb("place", { marker: [0, 0, 0], radiusMeters: 1, content, texture, visible: true, outline: null, displayScale: 1 });
    const orbMaterial = scene.getMaterialByName("sphere-orb-material-place") as ShaderMaterial;
    expect(orbMaterial.options.shaderLanguage).toBe(ShaderLanguage.GLSL);
    expect(orbMaterial.options.defines.includes("#define SPHERE_WEBGL2")).toBe(version === 2);
    expect(orbMaterial.options.defines.includes("#define SPHERE_TEXTURE_GRADIENTS")).toBe(version === 2);
    renderer.immersion.show({ source: { texture, kind: "cube", content }, next: { texture, kind: "equirectangular", content }, mix: 0.5 });
    expect(renderer.immersion.visible).toBe(true);
    const immersion = scene.getMeshByName("sphere-immersion")!.material as ShaderMaterial;
    expect(immersion.options.shaderLanguage).toBe(ShaderLanguage.GLSL);
    expect(immersion.options.defines).toContain("#define NEXT_EQUIRECT");
    renderer.dispose();
  });

  it("enables seam-correct gradient sampling on WebGL 1 when its extension exists", () => {
    const { renderer, scene } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true, textureLOD: true });
      Object.defineProperty(engine, "webGLVersion", { value: 1 });
    });
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "equirectangular", content } });
    const material = scene.getMeshByName("sphere-immersion")!.material as ShaderMaterial;
    expect(material.options.defines).toContain("#define SPHERE_TEXTURE_GRADIENTS");
    expect(material.options.defines).not.toContain("#define SPHERE_WEBGL2");
    renderer.dispose();
  });

  it("wakes a sleeping globe when a sphere shader finishes compiling", () => {
    const { renderer, scene, requestRender } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true });
    });
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "equirectangular", content } });
    const material = scene.getMeshByName("sphere-immersion")!.material as ShaderMaterial;
    requestRender.mockClear();
    material.onCompiled?.(null as never);
    expect(requestRender).toHaveBeenCalledOnce();
    renderer.dispose();
    requestRender.mockClear();
    material.onCompiled?.(null as never);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("explains a missing WebGL 1 capability instead of silently drawing incorrect depth", () => {
    const { renderer } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: false, standardDerivatives: true });
    });
    expect(renderer.available).toBe(false);
    expect(renderer.unavailableReason).toContain("EXT_frag_depth");
    renderer.dispose();
  });

  it("reports a shader rejection once and stops reporting after disposal", () => {
    const { renderer, scene, onError } = setup(engine => {
      Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true });
    });
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "equirectangular", content } });
    const material = scene.getMeshByName("sphere-immersion")!.material as ShaderMaterial;
    material.onError?.(null as never, "Driver rejected the shader");
    material.onError?.(null as never, "Driver rejected the shader");
    expect(onError).toHaveBeenCalledExactlyOnceWith("Driver rejected the shader");
    renderer.dispose();
    material.onError?.(null as never, "Another diagnostic after disposal");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps WebGPU's WGSL path without requiring WebGL extensions", () => {
    const { renderer, scene } = setup(engine => {
      Object.defineProperties(engine, { isWebGPU: { value: true }, _device: { value: {} } });
    });
    expect(renderer.available).toBe(true);
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "cube", content } });
    const material = scene.getMeshByName("sphere-immersion")!.material as ShaderMaterial;
    expect(material.options.shaderLanguage).toBe(ShaderLanguage.WGSL);
    expect(material.options.defines).not.toContain("#define SPHERE_WEBGL2");
    renderer.dispose();
  });
});

describe("sphere renderer camera frame", () => {
  it("follows a camera moved after it was read in the same rendered frame", () => {
    const { camera, renderer } = setup();
    const before = renderer.cameraFrame()!;
    expect(before.eye.map(value => Math.round(value * 1e9) / 1e9)).toEqual([0, 0, -10]);
    // Nothing is rendered between the two reads: the engine frame is the same.
    camera.position = new Vector3(5, 0, -10);
    camera.setTarget(Vector3.Zero());
    const after = renderer.cameraFrame()!;
    expect(after.eye[0]).toBeCloseTo(5, 9);
    expect(after.revision).not.toBe(before.revision);
    expect(after.view.forward[0]).toBeLessThan(0);
  });

  it("reads the eye and the view from the same camera state", () => {
    const { camera, renderer } = setup();
    renderer.cameraFrame();
    camera.position = new Vector3(0, 3, -4);
    camera.setTarget(Vector3.Zero());
    const frame = renderer.cameraFrame()!;
    // The forward axis points from the eye to the target, within the view matrix's float32 precision.
    const distance = Math.hypot(...frame.eye);
    for (let axis = 0; axis < 3; axis++) expect(frame.eye[axis] + frame.view.forward[axis] * distance).toBeCloseTo(0, 6);
  });

  it("projects into the camera's viewport when the world is only part of the canvas", () => {
    const { camera, engine, renderer } = setup();
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } as HTMLCanvasElement;
    engine.getRenderingCanvas = () => canvas;
    // The world is the bottom three quarters; Babylon measures its viewport from the bottom.
    camera.viewport = new Viewport(0, 0, 1, 0.75);
    const frame = renderer.cameraFrame()!;
    const centre = renderer.project(frame.view.forward, frame)!;
    expect(centre.x).toBeCloseTo(400, 6);
    expect(centre.y).toBeCloseTo(375, 6);
    // Halfway up the view: a quarter of the viewport's 450 px above its centre.
    const tanHalf = Math.tan(frame.view.verticalFovRad / 2);
    const raised = renderer.project(normalize(frame.view.forward.map((value, axis) => value + frame.view.up[axis] * tanHalf * 0.5) as Vec3), frame)!;
    expect(raised.y).toBeCloseTo(262.5, 6);
  });

  it("says whether a direction projects onto the canvas without reading the page's layout", () => {
    const { camera, engine, renderer } = setup();
    const box = vi.fn(() => ({ left: 3, top: 5, width: 800, height: 600 }));
    let canvas: HTMLCanvasElement | null = { getBoundingClientRect: box } as unknown as HTMLCanvasElement;
    engine.getRenderingCanvas = () => canvas;
    let state = 7;
    const random = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
    let on = 0, off = 0;
    for (let view = 0; view < 40; view++) {
      camera.position = new Vector3(random() * 20 - 10, random() * 20 - 10, random() * 20 - 10);
      camera.setTarget(new Vector3(random() - 0.5, random() - 0.5, random() - 0.5));
      camera.fov = 0.3 + random() * 2;
      camera.viewport = view % 3 ? new Viewport(0, 0, 1, 1) : new Viewport(0.1, 0, 0.8, 0.75);
      canvas = view % 5 === 4 ? null : { getBoundingClientRect: box } as unknown as HTMLCanvasElement;
      const frame = renderer.cameraFrame()!;
      for (let k = 0; k < 250; k++) {
        // Half the directions near the view's edges, where the 1.2 margin and the eye plane decide.
        const spread = k % 2 ? 4 : 0.2;
        const direction = k % 2
          ? [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1] as Vec3
          : frame.view.forward.map((value, axis) => value * (random() - 0.02) + (frame.view.right[axis] * (random() - 0.5) + frame.view.up[axis] * (random() - 0.5)) * spread * 3) as Vec3;
        const expected = renderer.project(direction, frame) !== null;
        const calls = box.mock.calls.length;
        expect(renderer.onScreen(direction, frame)).toBe(expected);
        expect(box.mock.calls.length).toBe(calls);
        if (expected) on++; else off++;
      }
    }
    expect(Math.min(on, off)).toBeGreaterThan(1000);
  });
});

describe("head-tracked drawing", () => {
  const content: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const presented = { position: { x: 0, y: 0, z: -10 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 }, verticalFovRad: 1 };

  it("draws each eye's own view instead of the presented view while a head is tracked", () => {
    let tracked = false;
    const { renderer } = setup(undefined, {}, { getPresentationView: () => presented, isHeadTracked: () => tracked });
    expect(renderer.cameraFrame()!.view.forward[1]).toBeCloseTo(1, 6);
    tracked = true;
    const frame = renderer.cameraFrame(presented)!;
    // The camera looks from z = -10 at the origin.
    expect(frame.view.forward[2]).toBeCloseTo(1, 6);
    expect(frame.view.verticalFovRad).not.toBe(1);
  });

  it("picks orbs along a world ray from its own origin", () => {
    const { renderer, scene } = setup(engine => { Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true }); });
    const texture = new BaseTexture(scene);
    renderer.addOrb("north", { marker: [0, 20, 0], radiusMeters: 1, content, texture, visible: true, outline: null, displayScale: 1 });
    renderer.addOrb("east", { marker: [20, 0, 0], radiusMeters: 1, content, texture, visible: true, outline: null, displayScale: 1 });
    const never = () => false;
    expect(renderer.pickRay([0, 0, 0], [0, 2, 0], never).map(hit => hit.id)).toEqual(["north"]);
    expect(renderer.pickRay([0, 0, 0], [1, 0, 0], never).map(hit => hit.id)).toEqual(["east"]);
    expect(renderer.pickRay([0, 0, 0], [0, 0, 1], never)).toEqual([]);
    expect(renderer.pickRay([0, 0, 0], [0, 1, 0], () => true)).toEqual([]);
    expect(renderer.pickRay([0, 0, 0], [0, 0, 0], never)).toEqual([]);
  });
});

describe("orb geometry", () => {
  it("leaves room beyond the silhouette for an outline, in CSS px at the orb's distance", () => {
    const frame = { view: { forward: [0, 0, 1] as Vec3, right: [1, 0, 0] as Vec3, up: [0, 1, 0] as Vec3, verticalFovRad: Math.PI / 2, aspect: 1 }, viewportHeightCssPx: 1000 };
    const plain = orbQuad([0, 0, 100], 1, frame, 0.1);
    const outlined = orbQuad([0, 0, 100], 1, frame, 0.1, 4);
    // 100 m away, 1000 CSS px span 200 m.
    expect(length(outlined.u) - length(plain.u)).toBeCloseTo(4 * 0.2, 9);
    expect(length(outlined.v) - length(plain.v)).toBeCloseTo(4 * 0.2, 9);
  });
});

describe("sphere renderer experiments", () => {
  const content: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // WebGL 1: the null engine has no uniform buffers to render a WebGL 2 frame with.
  const webGl = (engine: NullEngine) => {
    Object.assign(engine.getCaps(), { fragmentDepthSupported: true, standardDerivatives: true });
    Object.defineProperty(engine, "webGLVersion", { value: 1 });
  };
  const orbState = (scene: Scene) => ({ marker: [0, 0, 0] as Vec3, radiusMeters: 1, content, texture: new BaseTexture(scene), visible: true, outline: null, displayScale: 1 });

  it("records draws only while a check captures once the bookkeeping experiment is on", () => {
    const { renderer, scene } = setup(webGl);
    renderer.addOrb("place", orbState(scene));
    scene.render();
    expect(renderer.drawRecords().length).toBeGreaterThan(0);

    renderer.setExperiments({ bookkeeping: true });
    const kept = renderer.drawRecords().length;
    scene.render();
    expect(renderer.drawRecords()).toHaveLength(kept);

    renderer.captureDraws(true);
    scene.render();
    const records = renderer.drawRecords();
    expect(records.length).toBeGreaterThan(kept);
    // The revision a check reads is the same text either way, formatted when read.
    expect(records[0].cameraRevision).toBe(records[0].uniformRevision);
    expect(records[0].cameraRevision.split(",")).toHaveLength(11);
    renderer.dispose();
  });

  it("reads the canvas height once in each camera pass its orbs draw in, and again after a shader compiles or in a later task", async () => {
    let height = 400;
    const viewportHeightCssPx = vi.fn(() => height);
    const { renderer, scene, engine } = setup(webGl, {}, { viewportHeightCssPx });
    const outline = { color: [1, 1, 1, 1] as const, widthPx: 2 };
    for (const id of ["one", "two"]) renderer.addOrb(id, { ...orbState(scene), outline });
    const material = scene.getMaterialByName("sphere-orb-material-two") as ShaderMaterial;
    const widths: number[] = [];
    const setFloat = material.setFloat.bind(material);
    vi.spyOn(material, "setFloat").mockImplementation((name, value) => { if (name === "outlineWidth") widths.push(value); return setFloat(name, value); });
    // The outline is measured in drawn pixels: it shows the height the draw used.
    const usedHeight = () => 2 * engine.getRenderHeight() / widths.at(-1)!;
    const frame = () => { engine.beginFrame(); scene.render(); engine.endFrame(); };

    frame();
    expect(renderer.drawRecords().filter(record => record.target.startsWith("orb:"))).toHaveLength(2);
    expect(viewportHeightCssPx).toHaveBeenCalledTimes(1);
    expect(usedHeight()).toBeCloseTo(400, 9);
    height = 200;
    frame();
    expect(viewportHeightCssPx).toHaveBeenCalledTimes(2);
    expect(usedHeight()).toBeCloseTo(200, 9);

    // A draw in the same pass and task uses what the pass read.
    const draw = () => { const mesh = scene.getMeshByName("sphere-orb-two")!; mesh.onBeforeRenderObservable.notifyObservers(mesh); };
    height = 300;
    draw();
    expect(viewportHeightCssPx).toHaveBeenCalledTimes(2);
    expect(usedHeight()).toBeCloseTo(200, 9);
    // A compiled shader calls the host, which might have changed the page.
    material.onCompiled!(null as never);
    draw();
    expect(viewportHeightCssPx).toHaveBeenCalledTimes(3);
    expect(usedHeight()).toBeCloseTo(300, 9);
    height = 350;
    await Promise.resolve();
    draw();
    expect(viewportHeightCssPx).toHaveBeenCalledTimes(4);
    expect(usedHeight()).toBeCloseTo(350, 9);
    renderer.dispose();
  });

  it("gives the last 600 draws' records in order, however many were drawn", () => {
    const { renderer, scene, camera, engine } = setup(webGl);
    renderer.addOrb("place", orbState(scene));
    const drawn: ReturnType<typeof renderer.drawRecords>[number][] = [];
    for (let frame = 0; frame < 1300; frame++) {
      camera.position = new Vector3(frame % 7, 0, -10);
      const id = engine.frameId;
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      const records = renderer.drawRecords();
      for (const record of records) if (record.frameId === id) drawn.push(record);
      const expected = drawn.slice(-600);
      // Plain comparisons: an expect per record would take seconds.
      let same = records.length === expected.length;
      for (let index = 0; same && index < records.length; index++) same = records[index] === expected[index];
      if (!same) expect.fail(`frame ${frame}: ${records.length} records, not the last ${expected.length} drawn`);
    }
    expect(drawn.length).toBeGreaterThanOrEqual(1300);
    renderer.dispose();
  });

  it("gives the same camera revision with the bookkeeping experiment as without", () => {
    const plain = setup(webGl).renderer.cameraFrame()!;
    const lean = setup(webGl, { bookkeeping: true }).renderer.cameraFrame()!;
    expect(lean.revision).toBe(plain.revision);
    expect({ ...lean }.revision).toBe(plain.revision);
  });

  it("keeps a check's negative control working with the bookkeeping experiment", () => {
    const { renderer, scene, camera, engine } = setup(webGl, { bookkeeping: true });
    renderer.addOrb("place", orbState(scene));
    renderer.captureDraws(true);
    renderer.setUniformDelayFrames(1);
    for (let frame = 0; frame < 3; frame++) {
      camera.position = new Vector3(frame, 0, -10);
      // A frame of its own: the engine's frame id is what the history keys on.
      engine.beginFrame();
      scene.render();
      engine.endFrame();
    }
    const last = renderer.drawRecords().at(-1)!;
    expect(last.uniformRevision).not.toBe(last.cameraRevision);
    renderer.dispose();
  });

  it("draws immersion at full opacity without blending, and a fade with it", () => {
    const { renderer, scene } = setup(webGl, { opaqueImmersion: true });
    const texture = new BaseTexture(scene);
    const material = () => scene.getMeshByName("sphere-immersion")!.material as ShaderMaterial;
    renderer.immersion.show({ source: { texture, kind: "cube", content }, next: { texture, kind: "equirectangular", content }, mix: 0.5 });
    expect(material().needAlphaBlending()).toBe(false);
    renderer.immersion.show({ source: { texture, kind: "cube", content }, opacity: 0.5 });
    expect(material().needAlphaBlending()).toBe(true);
    renderer.immersion.show({ source: { texture, kind: "cube", content } });
    expect(material().needAlphaBlending()).toBe(false);
    renderer.immersion.setOpacity(0.4);
    expect(material().needAlphaBlending()).toBe(true);
    renderer.immersion.setOpacity(1);
    expect(material().needAlphaBlending()).toBe(false);
    renderer.setExperiments({ opaqueImmersion: false });
    expect(material().needAlphaBlending()).toBe(true);
    renderer.dispose();
  });

  it("switches every orb and the immersion to the lean WebGL shaders, and leaves WebGPU's alone", () => {
    const { renderer, scene } = setup(webGl);
    renderer.addOrb("place", orbState(scene));
    const orb = scene.getMaterialByName("sphere-orb-material-place") as ShaderMaterial;
    renderer.immersion.show({ source: { texture: new BaseTexture(scene), kind: "cube", content } });
    const immersion = () => scene.getMeshByName("sphere-immersion")!.material as ShaderMaterial;
    expect(orb.options.defines).not.toContain("#define SPHERE_LEAN");
    expect(immersion().options.defines).not.toContain("#define SPHERE_LEAN");
    renderer.setExperiments({ shaders: true });
    expect(orb.options.defines).toContain("#define SPHERE_LEAN");
    expect(immersion().options.defines).toContain("#define SPHERE_LEAN");
    renderer.setExperiments({ shaders: false });
    expect(orb.options.defines).not.toContain("#define SPHERE_LEAN");
    renderer.dispose();

    const gpu = setup(engine => Object.defineProperties(engine, { isWebGPU: { value: true }, _device: { value: {} } }), { shaders: true });
    gpu.renderer.addOrb("place", orbState(gpu.scene));
    expect((gpu.scene.getMaterialByName("sphere-orb-material-place") as ShaderMaterial).options.defines).not.toContain("#define SPHERE_LEAN");
    gpu.renderer.dispose();
  });
});

describe("lean shader inputs", () => {
  it("turn a clip-space corner into the ray the full shader rotates into the image", () => {
    const angle = 0.7;
    const content: Mat3 = [[Math.cos(angle), 0, -Math.sin(angle)], [0.3 * Math.sin(angle), Math.cos(0.3), 0.3], [Math.sin(angle), 0, Math.cos(angle)]].map(row => normalize(row as Vec3)) as Mat3;
    const rotation = Matrix.RotationYawPitchRoll(0.4, -0.2, 0.1);
    for (const projection of [Matrix.PerspectiveFovRH(1, 1.6, 0.1, 1000, false), Matrix.PerspectiveFovRH(0.6, 0.5, 2, 1e7, true)]) {
      const inverse = rotation.multiply(projection).invert();
      const lean = imageFromClipMatrix(inverse, content, new Matrix());
      for (const [x, y] of [[-1, -1], [3, -1], [-1, 3], [0.25, -0.5]]) {
        const ray = Vector4.TransformCoordinates(new Vector3(x, y, 0.5), inverse);
        const world = normalize([ray.x / ray.w, ray.y / ray.w, ray.z / ray.w]);
        const expected = normalize(content.map(row => dot(row, world)) as Vec3);
        const image = Vector4.TransformCoordinates(new Vector3(x, y, 0.5), lean);
        const actual = normalize([image.x, image.y, image.z]);
        for (let axis = 0; axis < 3; axis++) expect(actual[axis]).toBeCloseTo(expected[axis], 5);
        // w is the same at every corner, so the lean ray needs no division.
        expect(image.w).toBeCloseTo(1, 5);
      }
    }
  });

  it("gives an orb's per-draw constants as its fragments work them out", () => {
    for (const [rel, radius] of [[[0, 3, 40], 2], [[1, 0, 0.5], 2], [[500, 20, 0], 0.5]] as [Vec3, number][]) {
      const tanPreview = Math.tan(Math.PI / 4);
      const constants = orbDrawConstants(rel, radius, tanPreview);
      const d = length(rel);
      const sinAlpha = Math.min(radius / d, 1);
      const tanAlpha = sinAlpha / Math.max(Math.sqrt(Math.max(1 - sinAlpha ** 2, 0)), 1e-7);
      expect(constants.sinAlpha).toBeCloseTo(sinAlpha, 12);
      expect(constants.windowGain).toBeCloseTo(tanPreview / Math.max(tanAlpha, 1e-7), 9);
      expect(constants.identityWindow).toBe(d <= radius || tanAlpha >= tanPreview);
    }
  });
});
