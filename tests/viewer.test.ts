import { describe, expect, it, vi } from "vitest";
import type { ViewerSource } from "../src/viewer.js";
import { deferred, fixture, flush, image, representation, source } from "./fixtures/viewer.js";

describe("injected viewer lifecycle", () => {
  it("updates actions during a visit without reloading media and snapshots their metadata", async () => {
    const f = fixture(), input = image("a"), activate = vi.fn(() => true);
    const handle = await f.viewer.prepare(input, new AbortController().signal);
    await handle.ready(); f.viewer.replaceImages([handle]); await f.viewer.enter("a");
    const loads = f.acquire.mock.calls.length, listener = vi.fn(), off = f.viewer.subscribe(listener);
    const action = { id: "link", label: "Next image", direction: { headingDeg: 90, pitchDeg: 0 }, activate };
    f.viewer.updateActions!("a", [action]); action.direction.headingDeg = 180;
    expect(f.viewer.describeImage("a")?.actions[0].direction?.headingDeg).toBe(90);
    expect(await f.viewer.activateAction("link")).toBe(true); expect(activate).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalled(); expect(f.acquire).toHaveBeenCalledTimes(loads);
    f.viewer.updateActions!("a", []); expect(await f.viewer.activateAction("link")).toBe(false);
    expect(f.viewer.status().active).toBe("a"); off(); f.viewer.dispose();
  });
  it.each([0, 100])("keeps the incoming heading and pitch after entry and settling, with a %i ms flight", async flightDurationMs => {
    const f = fixture();
    const incoming = { headingDeg: 123, pitchDeg: -28, rollDeg: 0, verticalFovDeg: 60 };
    f.options.poses.viewFromPresentation = () => incoming;
    f.settings.flightDurationMs = flightDurationMs;
    f.settings.orientDurationMs = 100;
    const input = image("a");
    input.placement.marker = [6378147, 0, 0];
    const handle = await f.viewer.prepare(input, new AbortController().signal);
    await handle.ready();
    f.viewer.replaceImages([handle]);
    const entering = f.viewer.enter("a");
    await flush();
    if (flightDurationMs) await f.advance(flightDurationMs);
    expect(await entering).toBe(true);
    expect(f.viewer.status().view).toMatchObject({ headingDeg: 123, pitchDeg: -28 });
    await f.advance(200);
    expect(f.viewer.status().view).toMatchObject({ headingDeg: 123, pitchDeg: -28 });
    f.viewer.dispose();
    expect(f.holds.active).toBe(0);
  });
  it("flies in as one motion, growing the orb and widening to the entry field of view, and hands over once the eye is inside", async () => {
    const f = fixture();
    f.settings.flightDurationMs = 1000; f.settings.orientDurationMs = 250; f.settings.entryFovDeg = 80;
    f.options.poses.viewFromPresentation = (_input, presentation) => ({ headingDeg: 0, pitchDeg: 0, rollDeg: 0, verticalFovDeg: (presentation.verticalFovRad * 180) / Math.PI });
    const input = image("a");
    input.placement.marker = [6378147, 0, 0];
    const handle = await f.viewer.prepare(input, new AbortController().signal);
    await handle.ready();
    f.viewer.replaceImages([handle]);
    const place = vi.mocked(f.options.navigation.place);
    let entered = false;
    const entering = f.viewer.enter("a").then(ok => { entered = ok; return ok; });
    await flush();
    const radii: number[] = [];
    let elapsed = 0;
    while (!entered && elapsed < 1000) {
      await f.advance(16); elapsed += 16;
      const radius = f.orbs[0].expansion?.radiusMeters;
      if (radius !== undefined) radii.push(radius);
    }
    expect(await entering).toBe(true);
    expect(elapsed).toBeLessThan(1000);
    const fovs = place.mock.calls.map(([, presentation]) => (presentation.verticalFovRad * 180) / Math.PI);
    expect(fovs[0]).toBeGreaterThan(60);
    expect(fovs[0]).toBeLessThan(61);
    for (let n = 1; n < fovs.length; n++) expect(fovs[n]).toBeGreaterThan(fovs[n - 1]);
    for (let n = 1; n < radii.length; n++) expect(radii[n]).toBeGreaterThan(radii[n - 1]);
    expect(radii[0]).toBeLessThan(1.1);
    expect(radii.at(-1)).toBeGreaterThan(5);
    // The image takes over at the flight's last field of view and settles the rest of the way in the flight's time.
    const handed = f.viewer.status().view!.verticalFovDeg;
    expect(handed).toBeCloseTo(fovs.at(-1)!, 9);
    expect(handed).toBeLessThan(80);
    await f.advance(1000 - elapsed);
    expect(f.viewer.status().view!.verticalFovDeg).toBeCloseTo(80, 9);
    f.viewer.dispose();
    expect(f.holds.active).toBe(0);
  });
  it("flies out as one motion, shrinking the orb back to its own size while narrowing to the map's field of view", async () => {
    const f = fixture();
    f.settings.entryFovDeg = 80;
    f.options.poses.presentationFromView = (_input, view) => ({ position: { x: 6378147, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 1, y: 0, z: 0 }, verticalFovRad: (view.verticalFovDeg * Math.PI) / 180 });
    const input = image("a");
    input.placement.marker = [6378147, 0, 0];
    const handle = await f.viewer.prepare(input, new AbortController().signal);
    await handle.ready();
    f.viewer.replaceImages([handle]);
    expect(await f.viewer.enter("a")).toBe(true);
    expect(f.viewer.status().view!.verticalFovDeg).toBe(80);
    f.settings.flightDurationMs = 1000;
    const place = vi.mocked(f.options.navigation.place);
    place.mockClear();
    f.viewer.exit();
    await flush();
    const radii: number[] = [];
    for (let elapsed = 0; elapsed < 1000; elapsed += 16) {
      const radius = f.orbs[0].expansion?.radiusMeters;
      if (radius !== undefined) radii.push(radius);
      await f.advance(16);
    }
    await f.advance(16);
    const fovs = place.mock.calls.map(([, presentation]) => (presentation.verticalFovRad * 180) / Math.PI);
    expect(fovs[0]).toBeCloseTo(80, 9);
    for (let n = 1; n < fovs.length; n++) expect(fovs[n]).toBeLessThanOrEqual(fovs[n - 1]);
    expect(fovs.at(-1)).toBeCloseTo(60, 9);
    for (let n = 1; n < radii.length; n++) expect(radii[n]).toBeLessThanOrEqual(radii[n - 1]);
    // The orb starts out grown around the eye, and is back to the size it draws at from the overview.
    expect(radii[0]).toBeGreaterThan(10);
    expect(radii.at(-1)).toBeLessThan(1.6);
    expect(f.orbs[0].expansion).toBeNull();
    expect(f.options.navigation.restore).toHaveBeenCalledWith(expect.objectContaining({ camera: expect.objectContaining({ radius: 100 }) }), expect.anything());
    expect(f.viewer.status().phase).toBe("overview");
    f.viewer.dispose();
  });
  it("hides a published image on the map without dropping it from the set", async () => {
    const f = fixture();
    const handle = await f.viewer.prepare(image("a"), new AbortController().signal);
    await handle.ready();
    f.viewer.replaceImages([handle]);
    expect(f.orbs[0].state.visible).toBe(true);
    f.viewer.setMapVisibility(["a"]);
    expect(f.orbs[0].state.visible).toBe(false);
    expect(await f.viewer.enter("a")).toBe(true);
    f.viewer.dispose();
  });
  it("moves a published image while a visit has frozen ordinary placement, and ghosts it", async () => {
    const f = fixture();
    const handle = await f.viewer.prepare(image("a"), new AbortController().signal);
    await handle.ready();
    f.viewer.replaceImages([handle]);
    expect(await f.viewer.enter("a")).toBe(true);
    expect(f.viewer.isPlacementFrozen("a")).toBe(true);
    f.lease.setPresentationView.mockClear();
    f.viewer.reposition("a", {
      placement: { marker: [1, 2, 3], radiusMeters: 4, content: [[0, 1, 0], [1, 0, 0], [0, 0, 1]], outline: null, hoverScale: 1 },
      capture: { latitudeDeg: 45, longitudeDeg: -93, heightMeters: 12 },
    });
    expect(f.orbs[0].state.marker).toEqual([1, 2, 3]);
    expect(f.viewer.describeImage("a")?.details?.capture).toMatchObject({ latitudeDeg: 45, longitudeDeg: -93, heightMeters: 12 });
    expect(f.lease.setPresentationView).toHaveBeenCalled();
    expect(f.options.renderer.immersion.replaceContent).toHaveBeenCalled();
    expect(f.viewer.isPlacementFrozen("a")).toBe(true);
    f.viewer.setImageOpacity("a", 0.4);
    expect(f.orbs[0].state.opacity).toBe(0.4);
    expect(f.options.renderer.immersion.setOpacity).toHaveBeenCalledWith(0.4);
    f.viewer.dispose();
  });
  it("reports only published current sources and retains the successful preview limitation", async () => {
    const f=fixture(),input=image(),controller=new AbortController();
    f.options.resources.preview=()=>({representation:input.asset.representations[0],limitation:"original preview limit"});
    const handle=await f.viewer.prepare(input,controller.signal);await handle.ready();
    expect(f.viewer.isPlacementFrozen("a")).toBe(false);
    expect(f.viewer.currentSources("a")).toEqual({preview:null,shown:null});
    expect(f.viewer.describeResources("a")).toEqual({previewDetail:null});
    f.viewer.replaceImages([handle]);
    expect(f.viewer.currentSources("a")).toEqual({preview:"preview-64",shown:null});
    expect(f.viewer.describeResources("a")).toEqual({previewDetail:{representation:"preview-64",faceTexels:64,limitation:"original preview limit"}});
    f.options.resources.preview=()=>({representation:input.asset.representations[0],limitation:"a later policy observation"});
    expect(f.viewer.describeResources("a").previewDetail?.limitation).toBe("original preview limit");
    expect(await f.viewer.enter("a")).toBe(true);
    expect(f.viewer.isPlacementFrozen("a")).toBe(true);
    expect(f.viewer.currentSources("a")).toEqual({preview:"preview-64",shown:"preview-64"});
    f.viewer.exit();await flush();expect(f.viewer.currentSources("a")).toEqual({preview:"preview-64",shown:null});expect(f.viewer.isPlacementFrozen("a")).toBe(false);
    controller.abort();expect(f.viewer.currentSources("a")).toEqual({preview:null,shown:null});expect(f.viewer.describeResources("a")).toEqual({previewDetail:null});
    f.viewer.dispose();expect(f.viewer.currentSources("missing")).toEqual({preview:null,shown:null});expect(f.viewer.isPlacementFrozen("missing")).toBe(false);
  });
  it("does not report a cancelled late preview or an invalidated held source", async () => {
    const f=fixture(),pending=deferred<ViewerSource>(),controller=new AbortController();f.acquire.mockImplementationOnce(()=>pending.promise);
    const handle=await f.viewer.prepare(image(),controller.signal);f.viewer.replaceImages([handle]);
    const ready=handle.ready(),failure=expect(ready).rejects.toThrow();await flush();
    expect(f.viewer.currentSources("a")).toEqual({preview:null,shown:null});controller.abort();
    const late=source();pending.resolve(late);await failure;await flush();
    expect(late.release).toHaveBeenCalledTimes(1);expect(f.viewer.currentSources("a")).toEqual({preview:null,shown:null});expect(f.viewer.describeResources("a")).toEqual({previewDetail:null});
    const fresh=await f.viewer.prepare(image("b"),new AbortController().signal);await fresh.ready();f.viewer.replaceImages([fresh]);
    const held=await f.acquire.mock.results.at(-1)!.value;
    expect(f.viewer.currentSources("b").preview).toBe("preview-64");Object.assign(held,{isCurrent:()=>false});
    expect(f.viewer.currentSources("b")).toEqual({preview:null,shown:null});expect(f.viewer.describeResources("b")).toEqual({previewDetail:null});f.viewer.dispose();
  });
  it("keeps private incoming and borrowed fallback metadata out of published residency", async () => {
    const f=fixture(),handle=await f.viewer.prepare(image(),new AbortController().signal);await handle.ready();f.viewer.replaceImages([handle]);
    const whole=source("whole");f.immersion.mockReturnValueOnce({representation:whole.representation,limitation:null});f.acquire.mockResolvedValueOnce(whole);
    expect(await f.viewer.enter("a")).toBe(true);await flush();expect(f.viewer.currentSources("a").shown).toBe("whole");
    const pending=deferred<ViewerSource>(),incoming=source("tiles");let covered=false;
    Object.assign(incoming,{source:{texture:{label:"private-borrowed-cube"},kind:"tiles"},viewReady:()=>covered,detail:()=>({representation:"private-borrowed-cube"})});
    f.immersion.mockReturnValueOnce({representation:incoming.representation,limitation:null});f.acquire.mockImplementationOnce(()=>pending.promise);
    await f.advance(0);pending.resolve(incoming);await flush();
    expect(f.viewer.currentSources("a")).toEqual({preview:"preview-64",shown:"whole"});
    expect(f.viewer.describeResources("a").previewDetail?.representation).toBe("preview-64");
    covered=true;await f.advance(0);
    expect(f.viewer.currentSources("a")).toEqual({preview:"preview-64",shown:"tiles"});
    expect(f.viewer.currentSources("private-borrowed-cube")).toEqual({preview:null,shown:null});
    f.viewer.dispose();expect(f.viewer.currentSources("a")).toEqual({preview:null,shown:null});expect(f.holds.active).toBe(0);
  });
  it("prepares hidden immutable metadata, then publishes without sharing authored draw IDs", async () => {
    const f = fixture(), controller = new AbortController(), input = image();
    const first = await f.viewer.prepare(input, controller.signal);
    input.id = "mutated"; input.title = "mutated"; input.placement.radiusMeters = 99;
    await first.ready(); f.viewer.replaceImages([first]);
    expect(first.id).toBe("a"); expect(f.orbs[0].state.radiusMeters).toBe(1);
    const second = await f.viewer.prepare(image(), controller.signal); await second.ready();
    expect(f.orbs[0].id).not.toBe(f.orbs[1].id); expect(f.orbs[1].state.visible).toBe(false);
    f.viewer.replaceImages([second]); expect(f.orbs[0].state.visible).toBe(false); expect(f.orbs[1].state.visible).toBe(true);
    first.dispose(); second.dispose(); f.viewer.dispose();
  });
  it("validates the whole next set before changing visible metadata", async () => {
    const f = fixture(), first = await f.viewer.prepare(image(), new AbortController().signal);
    await first.ready(); f.viewer.replaceImages([first]);
    expect(() => f.viewer.replaceImages([first, first])).toThrow(/duplicate/);
    expect(f.orbs[0].state.visible).toBe(true); f.viewer.dispose();
  });
  it("rejects ready after cancellation and disposes an uncooperative late loader", async () => {
    const f = fixture(), result = deferred<ViewerSource>(), controller = new AbortController(); f.acquire.mockImplementationOnce(() => result.promise);
    const handle = await f.viewer.prepare(image(), controller.signal), ready = handle.ready();
    const failure = expect(ready).rejects.toThrow(); await flush(); controller.abort();
    const late = source(); result.resolve(late); await failure;
    expect(late.release).toHaveBeenCalledTimes(1); expect(f.orbs[0].dispose).toHaveBeenCalledTimes(1); f.viewer.dispose();
  });
  it("removes the host abort listener and detaches input exactly once", async () => {
    const f = fixture(), controller = new AbortController(), remove = vi.spyOn(controller.signal, "removeEventListener");
    const handle = await f.viewer.prepare(image(), controller.signal); await handle.ready(); f.viewer.replaceImages([handle]);
    expect(await f.viewer.enter("a")).toBe(true); f.viewer.exit(); await flush(); handle.dispose(); f.viewer.dispose();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)); expect(f.detach).toHaveBeenCalledTimes(1); expect(f.holds.active).toBe(0);
  });
  it("keeps idle frames idle and publishes appearance only when it changes", async () => {
    const f = fixture(); await f.advance(0); const count = f.render.mock.calls.length;
    for (let n=0; n<3; n++) expect(f.viewer.onFrame({ now: n, dtMs: 0 })).toBe(false);
    expect(f.render).toHaveBeenCalledTimes(count); f.settings.appearance.previewFovDeg = 100; await f.advance(1);
    expect(f.render).toHaveBeenCalledTimes(count+1); f.viewer.dispose();
  });
  it("a late cancelled refinement cannot overwrite the target image or double-release its preview", async () => {
    const f = fixture(), pending = deferred<ViewerSource>();
    const a = await f.viewer.prepare(image("a"), new AbortController().signal), b = await f.viewer.prepare(image("b"), new AbortController().signal);
    await a.ready(); await b.ready(); f.viewer.replaceImages([a,b]);
    const previewA = await f.acquire.mock.results[0].value;
    f.immersion.mockReturnValueOnce({ representation: representation("detail"), limitation: null }); f.acquire.mockImplementationOnce(() => pending.promise);
    expect(await f.viewer.enter("a")).toBe(true); await flush();
    expect(await f.viewer.enter("b")).toBe(true); const late = source("detail"); pending.resolve(late); await flush();
    expect(f.viewer.status().active).toBe("b"); expect(late.release).toHaveBeenCalledTimes(1); expect(previewA.release).not.toHaveBeenCalled(); f.viewer.dispose();
  });
  it("settles a refinement fade before capturing the next outgoing source", async () => {
    const f = fixture(), incoming = source("detail");
    const a = await f.viewer.prepare(image("a"), new AbortController().signal), b = await f.viewer.prepare(image("b"), new AbortController().signal);
    await a.ready(); await b.ready(); f.viewer.replaceImages([a,b]);
    expect(await f.viewer.enter("a")).toBe(true); f.settings.fadeDurationMs = 100;
    f.immersion.mockReturnValueOnce({ representation: representation("detail"), limitation: null }); f.acquire.mockResolvedValueOnce(incoming);
    await f.advance(0); const navigation = f.viewer.enter("b"); await flush(); await f.advance(100);
    expect(await navigation).toBe(true); expect(incoming.release).toHaveBeenCalledTimes(1); expect(f.viewer.status().active).toBe("b");
    f.viewer.dispose(); expect(f.holds.active).toBe(0);
  });
  it("an older navigation catch cannot publish over a newer target", async () => {
    const f = fixture(), pending = deferred<ViewerSource>();
    const handles = await Promise.all(["a","b","c"].map(id => f.viewer.prepare(image(id), new AbortController().signal)));
    await handles[0].ready(); await handles[2].ready(); f.viewer.replaceImages([handles[0],handles[2]]); expect(await f.viewer.enter("a")).toBe(true);
    f.acquire.mockImplementationOnce(() => pending.promise); f.viewer.replaceImages(handles); await flush();
    const old = f.viewer.enter("b"), newer = f.viewer.enter("c"); expect(await newer).toBe(true);
    pending.resolve(source()); expect(await old).toBe(false); expect(f.viewer.status().active).toBe("c"); f.viewer.dispose();
  });
  it("calls only the host's explicitly requested action", async () => {
    const f = fixture(), input = image(), go = vi.fn(() => true); input.actions = [{ id: "next", label: "Next", activate: go }];
    const handle = await f.viewer.prepare(input, new AbortController().signal); await handle.ready(); f.viewer.replaceImages([handle]);
    expect(go).not.toHaveBeenCalled(); expect(await f.viewer.activateAction("next")).toBe(false); await f.viewer.enter("a");
    expect(await f.viewer.activateAction("next")).toBe(true); expect(go).toHaveBeenCalledTimes(1); f.viewer.dispose();
  });
  it("host navigation revocation leaves the host's next presentation intact", async () => {
    const f = fixture(), handle = await f.viewer.prepare(image(), new AbortController().signal);
    await handle.ready(); f.viewer.replaceImages([handle]); await f.viewer.enter("a");
    f.abort.abort(); expect(f.options.navigation.restore).not.toHaveBeenCalled(); expect(f.viewer.status().phase).toBe("overview"); f.viewer.dispose();
  });
  it("an interrupted flight keeps momentum and settles the sharper borrowed preview after the outro", async () => {
    const f=fixture(),input=image(),pending=deferred<ViewerSource>();input.placement.marker=[6378147,0,0];
    const handle=await f.viewer.prepare(input,new AbortController().signal);await handle.ready();f.viewer.replaceImages([handle]);
    const original=await f.acquire.mock.results[0].value,sharper=source("preview-256");
    f.preview.mockReturnValue({representation:sharper.representation,limitation:null});f.acquire.mockImplementationOnce(()=>pending.promise);
    expect(await f.viewer.enter("a")).toBe(true);pending.resolve(sharper);await flush();expect(sharper.settleReplacement).not.toHaveBeenCalled();
    f.settings.flightDurationMs=1000;
    f.options.renderer.cameraFrame=()=>({eye:[6378147,-100,0],view:{forward:[0,1,0],right:[0,0,-1],up:[1,0,0],verticalFovRad:Math.PI/3,aspect:1.6},viewportHeightCssPx:900,revision:"fixture",viewRotProj:{} as never,inverseViewRotProj:{} as never});
    f.viewer.exit();await flush();await f.advance(200);f.cancelControllers.at(-1)!.abort(new Error("fresh host input"));await flush();
    expect(f.options.navigation.glide).toHaveBeenCalledTimes(1);const motion=vi.mocked(f.options.navigation.glide).mock.calls[0][3];expect(motion.velocity.some(value=>Math.abs(value)>0)).toBe(true);
    expect(original.release).not.toHaveBeenCalled();expect(sharper.settleReplacement).not.toHaveBeenCalled();await f.advance(1000);
    expect(original.release).toHaveBeenCalledTimes(1);expect(sharper.settleReplacement).toHaveBeenCalledTimes(1);f.viewer.dispose();expect(f.holds.active).toBe(0);
  });
  it("sizes orbs the renderer says are on screen without placing them on the page, or through projection when it cannot say", async () => {
    for (const visible of [true, false, undefined]) {
      const f = fixture(), input = image(); input.placement.marker = [6378147, 100, 0];
      const project = vi.fn(() => ({ x: 0, y: 0 }));
      Object.assign(f.options.renderer, { project }, visible === undefined ? {} : { onScreen: vi.fn(() => visible) });
      const handle = await f.viewer.prepare(input, new AbortController().signal); await handle.ready(); f.viewer.replaceImages([handle]); await flush();
      f.preview.mockClear(); await f.advance(16);
      const diameter = (f.preview.mock.calls.at(-1) as unknown[])[1];
      // Radius 1 m, 200 m away, 900 px tall at 60°.
      if (visible === false) expect(diameter).toBeNull(); else expect(diameter).toBeCloseTo(900 / (200 * Math.tan(Math.PI / 6)), 9);
      expect(project).toHaveBeenCalledTimes(visible === undefined ? 1 : 0);
      f.viewer.dispose();
    }
  });
  it("re-resolves an image after waiting for exit instead of entering removed metadata",async()=>{
    const f=fixture(),handle=await f.viewer.prepare(image(),new AbortController().signal);await handle.ready();f.viewer.replaceImages([handle]);await f.viewer.enter("a");
    f.settings.fadeDurationMs=100;f.viewer.exit();await flush();const entering=f.viewer.enter("a");f.viewer.replaceImages([]);await flush();
    expect(await entering).toBe(false);expect(f.viewer.status().active).toBeNull();expect(f.orbs[0].expansion).toBeNull();f.viewer.dispose();
  });
  it("awaits a current replacement after generation loss even when its authored representation ID is unchanged", async () => {
    const f = fixture(), handle = await f.viewer.prepare(image(), new AbortController().signal);
    await handle.ready(); f.viewer.replaceImages([handle]);
    const old = await f.acquire.mock.results[0].value, pending = deferred<ViewerSource>();
    Object.assign(old, { key: "asset@v1/preview-64/generation-0", isCurrent: () => false });
    f.preview.mockReturnValue({ representation: old.representation, limitation: null, key: "asset@v1/preview-64/generation-1" } as never);
    f.acquire.mockImplementationOnce(() => pending.promise);
    const entering = f.viewer.enter("a"); await flush();
    expect(f.viewer.status().phase).toBe("preparing"); expect(f.options.navigation.place).not.toHaveBeenCalled();
    expect(old.release).toHaveBeenCalledTimes(1); expect(f.orbs[0].state.texture).toBeNull();
    const fresh = source(); Object.assign(fresh, { key: "asset@v1/preview-64/generation-1", isCurrent: () => true }); pending.resolve(fresh);
    expect(await entering).toBe(true); expect(f.viewer.status().active).toBe("a"); f.viewer.dispose();
    expect(fresh.release).toHaveBeenCalledTimes(1);
  });
  it("keeps incoming tiles on the host frame during a fade and rechecks coverage before replacing a sharper whole image", async () => {
    const f = fixture(), handle = await f.viewer.prepare(image(), new AbortController().signal);
    await handle.ready(); f.viewer.replaceImages([handle]);
    const whole = source("whole"); f.immersion.mockReturnValueOnce({ representation: whole.representation, limitation: null }); f.acquire.mockResolvedValueOnce(whole);
    expect(await f.viewer.enter("a")).toBe(true); await flush(); expect(f.viewer.status().immersionDetail?.representation).toBe("whole");
    let covered = true;
    const tiles = source("tiles"), tick = vi.fn(() => false); Object.assign(tiles, { source: { kind: "tiles" }, onFrame: tick, viewReady: () => covered });
    f.settings.fadeDurationMs = 100; f.immersion.mockReturnValueOnce({ representation: tiles.representation, limitation: null }); f.acquire.mockResolvedValueOnce(tiles);
    await f.advance(0); const started = tick.mock.calls.length; await f.advance(25); expect(tick.mock.calls.length).toBeGreaterThan(started);
    covered = false; await f.advance(100); expect(f.viewer.status().immersionDetail?.representation).toBe("whole"); expect(whole.release).not.toHaveBeenCalled();
    const fading = tick.mock.calls.length; await f.advance(5); expect(tick.mock.calls.length).toBeGreaterThan(fading);
    covered = true; await f.advance(5); expect(f.viewer.status().immersionDetail?.representation).toBe("tiles"); expect(whole.release).toHaveBeenCalledTimes(1);
    expect(tiles.settleReplacement).toHaveBeenCalledTimes(1); f.viewer.dispose(); expect(f.holds.active).toBe(0);
  });
  it("turns an open sphere to face a heading and leaves a closed one alone", async () => {
    const f = fixture(), handle = await f.viewer.prepare(image(), new AbortController().signal);
    await handle.ready(); f.viewer.replaceImages([handle]);
    expect(f.viewer.face({ headingDeg: 0 })).toBe(false);
    expect(await f.viewer.enter("a")).toBe(true); await flush();
    const fov = f.viewer.status().view?.verticalFovDeg;
    expect(f.viewer.face({ headingDeg: 140, pitchDeg: 12 })).toBe(true);
    expect(f.viewer.status().view).toMatchObject({ headingDeg: 140, pitchDeg: 12, verticalFovDeg: fov });
    expect(f.viewer.face({ headingDeg: 0, pitchDeg: 0 })).toBe(true);
    expect(f.viewer.status().view).toMatchObject({ headingDeg: 0, pitchDeg: 0, verticalFovDeg: fov });
    f.viewer.exit(); await flush();
    expect(f.viewer.face({ headingDeg: 0, pitchDeg: 0 })).toBe(false);
    f.viewer.dispose();
  });
  it("opens at the field of view the settings ask for within the zoom range, the map's when there is none, and the scene's own view as it is", async () => {
    const f = fixture(), controller = new AbortController();
    const handles = await Promise.all([image("a"), { ...image("b"), initialView: { headingDeg: 30, pitchDeg: 5, verticalFovDeg: 50 } }].map(input => f.viewer.prepare(input, controller.signal)));
    await Promise.all(handles.map(handle => handle.ready())); f.viewer.replaceImages(handles);
    const enterAt = async (id: string, entryFovDeg: number | null | undefined): Promise<number | undefined> => {
      f.settings.entryFovDeg = entryFovDeg; expect(await f.viewer.enter(id)).toBe(true); await flush();
      const fov = f.viewer.status().view?.verticalFovDeg; f.viewer.exit(); await flush(); return fov;
    };
    // The map's camera comes in at 60°; the zoom range is 35° to 90°.
    expect(await enterAt("a", 80)).toBe(80); expect(await enterAt("a", 100)).toBe(90); expect(await enterAt("a", 20)).toBe(35);
    expect(await enterAt("a", null)).toBe(60); expect(await enterAt("a", undefined)).toBe(60);
    f.settings.entryOrientation = "authored"; expect(await enterAt("b", 100)).toBe(50); expect(await enterAt("a", 100)).toBe(90);
    f.viewer.dispose(); expect(f.holds.active).toBe(0);
  });
});

describe("picking along a ray", () => {
  it("names the shown images along a headset's pointer ray, on the map only", async () => {
    const f = fixture(), input = image("a");
    input.placement.marker = [6378147, 0, 0];
    const pickRay = vi.fn(() => [{ id: f.orbs[0]!.id, distance: 10 }, { id: "not-a-viewer-orb", distance: 20 }]);
    f.options.renderer.pickRay = pickRay as never;
    const handle = await f.viewer.prepare(input, new AbortController().signal);
    await handle.ready(); f.viewer.replaceImages([handle]); await f.advance(16);
    expect(f.viewer.pickRay!([1, 2, 3], [0, 1, 0])).toEqual(["a"]);
    expect(pickRay).toHaveBeenCalledWith([1, 2, 3], [0, 1, 0], f.options.isOccluded);
    await f.viewer.enter("a");
    expect(f.viewer.pickRay!([1, 2, 3], [0, 1, 0])).toEqual([]);
    f.viewer.dispose();
  });
});
