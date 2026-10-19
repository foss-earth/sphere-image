/** Optional DOM image-details tabs. The host supplies its UI sections and image metadata. */
import type { ImageRepresentation } from "@foss-earth/images";
import type { ImageViewer, ViewerImageInput, ViewerStatus } from "./ports.js";
import { SPHERE_TAB, SPHERE_SETTINGS_TAB } from "./settings.js";

export interface ImageDetailReading {
  shown?: string | null;
  loading?: string | null;
  limitation?: string | null;
  /** Representation owner formats its progress; no tile structure is reimplemented here. */
  progress?: readonly string[];
}
export interface ViewerPanelHandle { element: HTMLElement; destroy(): void }
export interface ViewerSectionsHandle extends ViewerPanelHandle { append?(entry: {id:string;title:string;element:HTMLElement;defaultOpen?:boolean}):void }
export interface ViewerPanelPorts {
  document: Document;
  viewer: Pick<ImageViewer, "status"|"subscribe"|"exit"|"activateAction">;
  /** Host resolves a generic image identity; this is not a scene-entity lookup in viewer code. */
  image(id: string): ViewerImageInput | null;
  sectionTitle(tab:string, section:string):string;
  /** Bind @foss-earth/ui/browser createParameterSection to the one host registry/refresh authority. */
  parameterSection(options:{tab:string;section:string;main?:HTMLElement;showAll?:boolean}):ViewerPanelHandle;
  sections(entries:readonly {id:string;title:string;element:HTMLElement;defaultOpen:boolean}[]):ViewerSectionsHandle;
  representationText(record: ImageRepresentation): string;
  detail(status: ViewerStatus): ImageDetailReading | null;
  externalLinkIcon?():SVGSVGElement;
  openSettings?():void;
  /** UI's trailing ? (createHelpTooltip), which shows `content` while pressed. */
  helpTooltip(options:{label:string;content:HTMLElement}):{element:HTMLElement;destroy():void};
  /** UI's compact action (createIconButton, bound to the document), for 360 image settings. */
  iconButton(options:{icon:"gear";label:string}):HTMLButtonElement;
}
export interface ViewerTabsSnapshot { title:string|null;onScreen:boolean }
export interface ViewerTabs { sphere:HTMLElement;settings:HTMLElement;getSnapshot():ViewerTabsSnapshot;subscribe(listener:()=>void):()=>void;leave():void;destroy():void }
const listed = (items:readonly (string|number)[]):string => items.length<=1 ? items.join("") : `${items.slice(0,-1).join(", ")} and ${items.at(-1)}`;
export function createViewerTabs(ports:ViewerPanelPorts):ViewerTabs {
  const { document:doc } = ports;
  const handles:ViewerPanelHandle[] = [], listeners = new Set<()=>void>(); let disposed = false, rendered = "", snapshot:ViewerTabsSnapshot = { title:null,onScreen:false };
  function el<K extends keyof HTMLElementTagNameMap>(tag:K, className?:string, text?:string):HTMLElementTagNameMap[K] { const item=doc.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item; }
  const note = (text:string) => el("p","foss-earth-choices__note",text);
  const button = (text:string, action:()=>void) => { const item=el("button","foss-earth-choice foss-earth-scene-button",text);item.type="button";item.addEventListener("click",action);return item; };
  const photograph=el("div","foss-earth-choices foss-earth-sphere-photograph"), links=el("div","foss-earth-choices"), detail=el("div","foss-earth-choices");
  const section = (tab:string,id:string,main?:HTMLElement,showAll=true) => {const result=ports.parameterSection({tab,section:id,showAll,...(main?{main}:{})});handles.push(result);return result.element;};
  const sphereSections=ports.sections([
    {id:"panorama.links",title:ports.sectionTitle(SPHERE_TAB,"links"),element:section(SPHERE_TAB,"links",links,false),defaultOpen:false},
    {id:"panorama.detail",title:ports.sectionTitle(SPHERE_TAB,"detail"),element:section(SPHERE_TAB,"detail",detail),defaultOpen:false},
  ]);
  const sphere=el("div","foss-earth-sphere-tab");
  sphere.append(photograph,sphereSections.element);
  // What the panorama offers and how entering goes, behind the detail's ?. It and the settings mark stay across
  // renders, which come with each step of loading, so an open ? stays open.
  const offers=note(""), about=el("div");
  about.append(note("Entering: the preview shows first, then the largest image the detail allows."),offers);
  if(ports.openSettings)about.append(note("360 image settings hold the representation, sharpness, looking and levelling."));
  const help=ports.helpTooltip({label:"Explain the detail",content:about});
  const openSettings=ports.openSettings?ports.iconButton({icon:"gear",label:"360 image settings"}):null;
  openSettings?.addEventListener("click",()=>{if(!disposed)ports.openSettings?.();});
  const kept:HTMLElement[]=[...(openSettings?[openSettings]:[]),help.element];
  detail.append(...kept);
  const settings=ports.sections(["image","looking","entering"].map(id=>({id:`panorama-settings.${id}`,title:ports.sectionTitle(SPHERE_SETTINGS_TAB,id),element:section(SPHERE_SETTINGS_TAB,id),defaultOpen:id==="image"})));
  function render(status:ViewerStatus):void {
    if(disposed)return;
    const id=["preparing","entering","immersive"].includes(status.phase)? status.active??status.target:null;
    const entry=id?ports.image(id):null, title=entry?.title??null,onScreen=!!entry&&status.active!==null;
    if(title!==snapshot.title||onScreen!==snapshot.onScreen){snapshot={title,onScreen};for(const listener of [...listeners])listener();}
    const reading=ports.detail(status), key=JSON.stringify([status.phase,status.active,entry,reading]);
    if(key===rendered)return;rendered=key;
    photograph.replaceChildren();links.replaceChildren();for(const child of [...detail.children])if(!kept.includes(child as HTMLElement))child.remove();
    for(const item of kept)item.hidden=!entry;if(!entry)return;
    const inside=status.phase==="immersive"&&status.active===entry.id;
    if(entry.description)photograph.append(note(entry.description));
    if(entry.details?.groups?.length)photograph.append(note(`In ${listed(entry.details.groups)}.`));
    if(!entry.actions.length)links.append(note("No links lead from this panorama."));
    for(const action of entry.actions){const go=button(action.label,()=>{if(!disposed)void ports.viewer.activateAction(action.id);});go.disabled=!inside;links.append(go);}
    // "Showing …" and "Loading …" stay in view; "[⚙] [?]" follow them.
    const lines=!reading?.shown||!inside?[note("Entering…")]:[note(`Showing ${reading.shown}.`),...(reading.progress??[]).map(note),note(reading.loading?`Loading ${reading.loading}…`:reading.limitation??"It is the largest image this panorama offers.")];
    kept[0].before(...lines);
    offers.textContent=`This panorama offers ${listed(entry.asset.representations.map(ports.representationText))}.`;
  }
  const off=ports.viewer.subscribe(render);render(ports.viewer.status());
  return {sphere,settings:settings.element,getSnapshot:()=>snapshot,subscribe(listener){if(!disposed)listeners.add(listener);return()=>{listeners.delete(listener);};},leave(){if(!disposed)ports.viewer.exit();},destroy(){if(disposed)return;disposed=true;off();listeners.clear();help.destroy();for(const handle of handles)handle.destroy();sphereSections.destroy();sphere.remove();settings.destroy();}};
}
