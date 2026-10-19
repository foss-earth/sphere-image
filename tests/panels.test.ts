// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createHelpTooltip, createIconButton } from "@foss-earth/ui/browser";
import { createViewerTabs } from "../src/panels.js";
import type { ViewerStatus } from "../src/index.js";
import { image } from "./fixtures/viewer.js";
describe("host-composed image tabs",()=>{
  it("shows the authored description and actions while retaining metadata, and tears down every host section",()=>{
    let state:ViewerStatus={phase:"overview",active:null,target:null};let listener:(s:ViewerStatus)=>void=()=>{};
    const off=vi.fn(),destroy=vi.fn(),openSettings=vi.fn(),exit=vi.fn(),activateAction=vi.fn(async()=>true),input=image();input.description="A view from campus.";input.credits.url="https://example.com/source";input.details={capture:{latitudeDeg:44.978552,longitudeDeg:-93.239638,heightMeters:null,horizontalAccuracyMeters:50},groups:["Campus tour"]};input.pose.aligned=false;input.actions=[{id:"next",label:"Next view",activate:()=>true}];
    const metadata=structuredClone({asset:input.asset,credits:input.credits,details:input.details,pose:input.pose});
    const tabs=createViewerTabs({document,viewer:{status:()=>state,subscribe(fn){listener=fn;fn(state);return off;},exit,activateAction},image:()=>input,sectionTitle:(_tab,section)=>section,parameterSection({main}){const element=document.createElement("div");if(main)element.append(main);return{element,destroy};},sections(entries){const element=document.createElement("div");element.append(...entries.map(entry=>entry.element));return{element,destroy};},representationText:r=>r.id,detail:()=>({shown:"the test image"}),openSettings,helpTooltip:createHelpTooltip,iconButton:options=>createIconButton(document,options)});
    state={phase:"immersive",active:"a",target:null};listener(state);expect(tabs.getSnapshot()).toEqual({title:"Image a",onScreen:true});
    expect(tabs.sphere.querySelector(".foss-earth-sphere-photograph")?.textContent).toBe("A view from campus.In Campus tour.");expect(tabs.sphere.querySelector("a")).toBeNull();
    expect({asset:input.asset,credits:input.credits,details:input.details,pose:input.pose}).toEqual(metadata);
    // "Showing the test image." in view, then "[⚙] [?]"; what the panorama offers is behind ?.
    const detail=tabs.sphere.querySelector<HTMLButtonElement>('[aria-label="360 image settings"]')!.parentElement!;
    expect([...detail.querySelectorAll(":scope > p")].map(line=>line.textContent)).toEqual(["Showing the test image.","It is the largest image this panorama offers."]);
    expect(detail.lastElementChild?.querySelector("button")?.getAttribute("aria-label")).toBe("Explain the detail");expect(detail.lastElementChild?.textContent).toContain("This panorama offers");
    const gear=detail.querySelector<HTMLButtonElement>('[aria-label="360 image settings"]')!;expect(gear.dataset.icon).toBe("gear");gear.click();expect(openSettings).toHaveBeenCalledOnce();
    tabs.sphere.querySelector<HTMLButtonElement>("button")!.click();expect(activateAction).toHaveBeenCalledWith("next");tabs.leave();expect(exit).toHaveBeenCalledOnce();
    expect(tabs.sphere.firstElementChild?.classList.contains("foss-earth-sphere-photograph")).toBe(true);
    tabs.destroy();tabs.destroy();expect(off).toHaveBeenCalledOnce();expect(destroy).toHaveBeenCalledTimes(7);listener({phase:"overview",active:null,target:null});expect(tabs.getSnapshot().title).toBe("Image a");
  });
});
