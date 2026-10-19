import assert from "node:assert/strict";
import { mkdirSync,readFileSync,writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
let pureImport=true;
registerHooks({resolve(specifier,context,next){if(pureImport&&(specifier.startsWith("@felipegalind0/gamepad-tools")||specifier.startsWith("@foss-earth/engine")))throw new Error("PURE_IMPORT_TOUCHED_CONTROLLER_OR_ENGINE_RUNTIME");return next(specifier,context);}});
const names=["window","document","navigator","ImageBitmap","OffscreenCanvas","HTMLCanvasElement"],previous=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,get(){throw new Error(`PURE_IMPORT_TOUCHED_${name}`);}});
const root=await import("@foss-earth/sphere-image");assert.equal(typeof root.createViewerSelection,"function");
const pureCore=await import("@foss-earth/sphere-image/core");assert.equal(pureCore.SPHERE_GAMEPAD_ACTIONS,root.SPHERE_GAMEPAD_ACTIONS);assert.equal(pureCore.createSphereProfileContribution,root.createSphereProfileContribution);
await assert.rejects(import("@felipegalind0/gamepad-tools/core"),/PURE_IMPORT_TOUCHED_CONTROLLER_OR_ENGINE_RUNTIME/);
assert.deepEqual(root.SPHERE_GAMEPAD_ACTIONS,[
  {id:"panorama.lookX",label:"Look left / right",category:"Panorama",kind:"rate",range:[-1,1],contexts:["panorama"],available:true},
  {id:"panorama.lookY",label:"Look down / up",category:"Panorama",kind:"rate",range:[-1,1],contexts:["panorama"],available:true},
  {id:"panorama.zoom",label:"Zoom in / out",category:"Panorama",kind:"rate",range:[-1,1],contexts:["panorama"],available:true},
  {id:"panorama.exit",label:"Exit the panorama",category:"Panorama",kind:"command",contexts:["panorama"],available:true},
]);
assert.equal(typeof(await import("@foss-earth/sphere-image/viewer")).createImageViewer,"function");
assert.equal(typeof(await import("@foss-earth/sphere-image/settings")).VIEWER_PARAMETERS,"object");
const viewerSettings=await import("@foss-earth/sphere-image/settings");
assert.deepEqual(viewerSettings.VIEWER_EXPERIMENT_IDS,{sphereBookkeeping:"renderer.experiments.panoramaBookkeeping",opaqueImmersion:"renderer.experiments.opaqueImmersion",sphereShaders:"renderer.experiments.panoramaShaders"});
assert.deepEqual(viewerSettings.VIEWER_EXPERIMENT_PARAMETERS.map(spec=>spec.id),Object.values(viewerSettings.VIEWER_EXPERIMENT_IDS));
assert.deepEqual(viewerSettings.VIEWER_EXPERIMENT_PARAMETERS.map(spec=>spec.label),["Panorama draws without test records","Opaque panorama","Simpler panorama shaders"]);
assert.deepEqual(viewerSettings.VIEWER_EXPERIMENT_PARAMETERS.map(spec=>spec.description),[
  "Stops recording every panorama draw, its camera as text and earlier frames' uniforms, which only the renderer's own checks read; a check turns recording back on. Review candidate 5.",
  "Draws a panorama shown at full opacity without blending it over the frame behind, crossfades between two of its images included; fades from the globe still blend. Review candidate 6.",
  "WebGL only: works out each orb's per-draw constants once on the CPU instead of in every pixel, turns the panorama's view into the image's frame in the vertex shader, and normalizes each ray once or, for a cube, not at all. Review candidate 7.",
]);
for(const spec of viewerSettings.VIEWER_EXPERIMENT_PARAMETERS){
  assert.equal(spec.kind,"boolean");assert.equal(spec.unit,"none");assert.equal(spec.default,false);assert.equal(spec.bounds,undefined);assert.equal(spec.appliesLive,true);
  assert.equal(spec.defaultReason,"Under A/B validation: meant to draw the same picture with less work, not yet confirmed on devices.");
  assert.deepEqual(spec.home,{tab:"renderer",section:"experiments",level:"main"});assert.equal(spec.source,"src/engine/babylon/panorama/panoramaRenderer.ts");
  assert.equal(viewerSettings.VIEWER_PARAMETERS.filter(record=>record.id===spec.id).length,1);
}
for(const id of ["renderer.experiments.all","renderer.experiments.presentationCandidates"])assert.equal(viewerSettings.VIEWER_PARAMETERS.some(spec=>spec.id===id),false);
pureImport=false;
for(const[name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
const {DEFAULT_BINDING_TRANSFORM}=await import("@felipegalind0/gamepad-tools/core");
const {createStandardGlobeProfile,createGlobeGamepadAdapter}=await import("@foss-earth/engine/gamepad");
const contribution=root.createSphereProfileContribution(DEFAULT_BINDING_TRANSFORM);
assert.deepEqual(contribution.contexts,["panorama"]);
const expectedBindings=(slot,deadzone)=>[
  {id:"standard-panorama-look-x",actionId:"panorama.lookX",kind:"single",semantics:"rate",contexts:["panorama"],enabled:true,precedence:0,transform:{...DEFAULT_BINDING_TRANSFORM,deadzone,invert:false},source:{selector:{kind:"gamepad-axis",gamepadSlot:slot,axisIndex:2}}},
  {id:"standard-panorama-look-y",actionId:"panorama.lookY",kind:"single",semantics:"rate",contexts:["panorama"],enabled:true,precedence:0,transform:{...DEFAULT_BINDING_TRANSFORM,deadzone,invert:true},source:{selector:{kind:"gamepad-axis",gamepadSlot:slot,axisIndex:3}}},
  {id:"standard-panorama-zoom",actionId:"panorama.zoom",kind:"paired",semantics:"rate",contexts:["panorama"],enabled:true,precedence:0,transform:{...DEFAULT_BINDING_TRANSFORM,inputRange:[0,1],outputRange:[-1,1]},positiveSource:{selector:{kind:"gamepad-button",gamepadSlot:slot,buttonIndex:7}},negativeSource:{selector:{kind:"gamepad-button",gamepadSlot:slot,buttonIndex:6}}},
  {id:"standard-panorama-exit",actionId:"panorama.exit",kind:"single",semantics:"command",contexts:["panorama"],enabled:true,precedence:0,transform:{...DEFAULT_BINDING_TRANSFORM,inputRange:[0,1],outputRange:[0,1]},source:{selector:{kind:"gamepad-button",gamepadSlot:slot,buttonIndex:1}}},
];
assert.deepEqual(contribution.bindings(3,.21),expectedBindings(3,.21));
const controllerProfile=createStandardGlobeProfile(undefined,undefined,contribution);
assert.deepEqual(controllerProfile.contexts,["globe","panorama"]);
assert.deepEqual(controllerProfile.bindings.filter(binding=>binding.contexts.includes("panorama")),expectedBindings(0,.15));
const adapter=createGlobeGamepadAdapter({applyGlobeNavigationIntents(){}},{featureActions:root.SPHERE_GAMEPAD_ACTIONS,getContext:()=>"panorama"});
assert.deepEqual(adapter.actions.filter(action=>action.contexts.includes("panorama")),root.SPHERE_GAMEPAD_ACTIONS);assert.equal(adapter.getContext(),"panorama");
await assert.rejects(import("__OUTSIDE_IMPORT__",{with:{type:"json"}}),/OUTSIDE_INSTALLED_WORKSPACE/);
for(const entry of ["@foss-earth/sphere-image/resources","@foss-earth/sphere-image/input","@foss-earth/sphere-image/panels","@foss-earth/sphere-image/babylon","@foss-earth/sphere-image/shaders","@foss-earth/sphere-image/shaders-webgl","@foss-earth/sphere-image/core","@foss-earth/sphere-image/node"]){await import(entry);assert(import.meta.resolve(entry).includes("node_modules/"));}
const {prepareSphere}=await import("@foss-earth/sphere-image/preparation");mkdirSync("prepared",{recursive:true});writeFileSync("pose.json",JSON.stringify({headingDeg:37,pitchDeg:-4,rollDeg:12,provenance:"injected fixture author"}));
const output=prepareSphere(["--input","synthetic:cardinal:64","--pose","pose.json","--attribution","Fixture photographer","--preview-face-sizes","8,16","--immersion-widths","64","--tiles","eac,cube","--tile-size","8","--tile-face-size","16","--encoding","png","--out","prepared"],{log:()=>{}});
assert.equal(output.exitCode,0);assert.equal(output.fragment.asset.representations.length,5);assert.equal(output.provenance.toolVersion,"1");assert.equal(JSON.parse(readFileSync("prepared/asset.fragment.json")).imagePose.headingDeg,37);
const cli=spawnSync(process.execPath,[...process.execArgv,new URL(import.meta.resolve("@foss-earth/sphere-image/prepare-cli")).pathname,"--help"],{encoding:"utf8"});assert.equal(cli.status,0,cli.stderr);assert.match(cli.stdout,/synthetic:cardinal/);
const {JSDOM}=await import("jsdom"),doc=new JSDOM("<!doctype html>").window.document;
const {createViewerTabs}=await import("@foss-earth/sphere-image/panels");let phase="immersive",subscriber;let stopped=0;
const input={id:"placed",title:"Published image",asset:output.fragment.asset,pose:output.fragment.imagePose,placement:{marker:null,radiusMeters:1,content:[[1,0,0],[0,1,0],[0,0,1]],outline:null,hoverScale:1},credits:{text:"Injected photographer"},actions:[]};
{
  // Actual public resource composition delegates each source's current policy
  // to the real tiled owner, using common acquisition for the shared preview.
  const {createImageSessionBroker,createImageSourceCache}=await import("@foss-earth/images");
  const {createImageFileService}=await import("@foss-earth/images/browser");
  const {tileAtlasLayout}=await import("@foss-earth/sphere-tiled-cubemap");
  const {createViewerResources}=await import("@foss-earth/sphere-image/resources");
  const broker=createImageSessionBroker({requests:2,decodes:1,pools:{encoded:1000,decoded:1000,sourceGpu:1e6,overlap:1e6,uploadOutstanding:1000}});
  const cache=createImageSourceCache({broker,keptGpuBytes:0,gpuBytes:source=>source.gpuBytes});
  const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0,0]);
  const files=createImageFileService({broker,priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000}),fetch:async()=>new Response(png,{headers:{"content-type":"image/png"}}),decode:async()=>({width:1,height:1,close(){}})});
  const preview={id:"policy-preview",role:"preview",projection:"cube",mimeType:"image/png",encodedBytes:6,faceSize:1,faces:Object.fromEntries(["px","nx","py","ny","pz","nz"].map(face=>[face,`https://fixture.invalid/preview/${face}`]))};
  const pyramids=[
    {id:"small-tiles",role:"immersion",projection:"tiled-cube",mimeType:"image/png",encodedBytes:126,warp:"gnomonic",faceSize:8,tileSize:2,gutter:0,levelBytes:[6,24,96],url:"https://fixture.invalid/small/"},
    {id:"large-tiles",role:"immersion",projection:"tiled-cube",mimeType:"image/png",encodedBytes:30,warp:"gnomonic",faceSize:8,tileSize:4,gutter:0,levelBytes:[6,24],url:"https://fixture.invalid/large/"},
  ];
  let immersionWidth=16;const selected=[];const handles=[];
  const resources=createViewerResources({broker,cache,files,atlasDevice:{},uploader:{upload:async()=>({kind:"cube",width:1,height:1,levels:1,gpuBytes:24,texture:{},complete:true,dispose(){}})},previewSheetsEnabled:()=>false,maxTextureSide:()=>4096,whenReady:async()=>{},
    estimate:record=>({encoded:0,decoded:0,sourceGpu:record.projection==="tiled-cube"?tileAtlasLayout(record,4096,4096).gpuBytes:24,uploadOutstanding:0}),
    choice:{preview:()=>({representation:preview,limitation:null}),immersion:()=>null,faceTexels:()=>1},
    tiles:{memoryBytes:()=>4096,limits:()=>({requests:1,waiting:1,decodes:1,uploadsPerFrame:1,retries:0,retryDelayMs:1,fadeMs:0}),selection(record){const levelCap=Math.max(0,Math.min(record.levelBytes.length-1,Math.floor(Math.log2(immersionWidth/(4*record.tileSize)))));selected.push({record,levelCap});return{texelsPerPixel:1,marginDeg:0,levelCap};},outlines:()=>false},
    createAtlas:({layout})=>({layout,atlas:{},table:{},beginUpdate:()=>true,endUpdate(){},uploadTile:()=>true,setTable:()=>true,dispose(){}}),devicePixelsPerCss:()=>1,requestRender(){}});
  const placed={...input,asset:{...input.asset,id:"policy-asset",revision:"v1",representations:[preview,...pyramids]}};
  const camera={eye:[0,0,0],view:{forward:[1,0,0],right:[0,0,1],up:[0,1,0],verticalFovRad:Math.PI/3,aspect:1},viewportHeightCssPx:900,revision:"policy",viewRotProj:{},inverseViewRotProj:{}};
  try {
    for(const representation of pyramids)handles.push(await resources.acquire(placed,{representation,limitation:null},{signal:new AbortController().signal,priority:0,overlap:false}));
    for(const handle of handles)handle.onFrame(camera,0,placed.placement.content);
    assert.equal(selected[0].record,pyramids[0]);assert.equal(selected[1].record,pyramids[1]);assert.deepEqual(selected.map(choice=>choice.levelCap),[1,0]);
    assert.match(handles[0].detail().progress[0],/at level 1 of 2/);assert.match(handles[1].detail().progress[0],/at level 0 of 1/);
    immersionWidth=32;
    for(const handle of handles)handle.onFrame(camera,50,placed.placement.content);
    assert.deepEqual(selected.slice(2).map(choice=>choice.levelCap),[2,1]);
    assert.match(handles[0].detail().progress[0],/at level 2 of 2/);assert.match(handles[1].detail().progress[0],/at level 1 of 1/);
  } finally {for(const handle of handles)handle.release();cache.dispose();broker.dispose();}
  for(let n=0;n<20;n++)await Promise.resolve();assert.deepEqual(broker.pools.live(),[]);
}
{
  // Saved files are grouped by asset revision and representation, never URL.
  // Actual common file services all use this one broker; tiled fallback uses
  // its preview's service instead of inheriting the tile group's saved files.
  const {createImageSessionBroker,createImageSourceCache,mediaGroup}=await import("@foss-earth/images");
  const {createImageFileService}=await import("@foss-earth/images/browser");
  const {tileAtlasLayout}=await import("@foss-earth/sphere-tiled-cubemap");
  const {createViewerResources}=await import("@foss-earth/sphere-image/resources");
  const broker=createImageSessionBroker({requests:2,decodes:1,pools:{encoded:1000,decoded:1000,sourceGpu:1e6,overlap:1e6,uploadOutstanding:1000}});
  const cache=createImageSourceCache({broker,keptGpuBytes:0,gpuBytes:source=>source.gpuBytes});
  const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0,0]);
  const faces=Object.fromEntries(["px","nx","py","ny","pz","nz"].map(face=>[face,`https://fixture.invalid/shared/${face}`]));
  const preview={id:"preview",role:"preview",projection:"cube",mimeType:"image/png",encodedBytes:198,faceSize:1,faces};
  const alternate={...preview,id:"alternate"};
  const tiles={id:"tiles",role:"immersion",projection:"tiled-cube",mimeType:"image/png",encodedBytes:126,warp:"gnomonic",faceSize:8,tileSize:2,gutter:0,levelBytes:[6,24,96],url:"https://fixture.invalid/group-tiles/"};
  const services=new Map(),selected=[],reads=[],handles=[];let networkCalls=0,fallbackCalls=0,closed=0;
  const resources=createViewerResources({broker,cache,atlasDevice:{},
    files:{async obtain(){fallbackCalls++;throw new Error("Grouped acquisition must use its exact service.");},async decode(){fallbackCalls++;throw new Error("Grouped decoding must use its exact service.");}},
    filesFor(placed,representation){
      const group=mediaGroup(placed.asset,representation);selected.push(group.id);
      if(!services.has(group.id))services.set(group.id,createImageFileService({broker,priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000}),
        fetch:async()=>{networkCalls++;throw new Error("Each grouped fixture file is already saved.");},decode:async()=>({width:1,height:1,close(){closed++;}}),
        cache:{files:{get:async()=>null,async getBounded(url,admission){reads.push({group:group.id,url});if(!admission.admit(png.byteLength))return null;return{bytes:png.slice(),contentType:"image/png"};},put(){},forget(){}},settled:async()=>{}}}));
      return services.get(group.id);
    },
    uploader:{upload:async()=>({kind:"cube",width:1,height:1,levels:1,gpuBytes:24,texture:{},complete:true,dispose(){}})},previewSheetsEnabled:()=>false,maxTextureSide:()=>4096,whenReady:async()=>{},
    estimate:representation=>({encoded:0,decoded:0,sourceGpu:representation.projection==="tiled-cube"?tileAtlasLayout(representation,4096,4096).gpuBytes:24,uploadOutstanding:0}),
    choice:{preview:()=>({representation:preview,limitation:null}),immersion:()=>null,warm:()=>({representation:tiles,limitation:null}),faceTexels:()=>1},
    tiles:{memoryBytes:()=>4096,limits:()=>({requests:1,waiting:1,decodes:1,uploadsPerFrame:1,retries:0,retryDelayMs:1,fadeMs:0}),selection:()=>({texelsPerPixel:1,marginDeg:0,levelCap:0}),outlines:()=>false},
    createAtlas:({layout})=>({layout,atlas:{},table:{},beginUpdate:()=>true,endUpdate(){},uploadTile:()=>true,setTable:()=>true,dispose(){}}),devicePixelsPerCss:()=>1,requestRender(){}});
  const placed=revision=>({...input,asset:{...input.asset,id:"shared-asset",revision,representations:[preview,alternate,tiles]}});
  try{
    for(const [entry,representation]of [[placed("v1"),preview],[placed("v2"),preview],[placed("v1"),alternate],[placed("v3"),tiles]])handles.push(await resources.acquire(entry,{representation,limitation:null},{signal:new AbortController().signal,priority:0,overlap:false}));
    const repeated=await resources.acquire({...placed("v1"),id:"another-placement"},{representation:preview,limitation:null},{signal:new AbortController().signal,priority:0,overlap:false});handles.push(repeated);
    assert.deepEqual(selected,["shared-asset@v1/preview","shared-asset@v2/preview","shared-asset@v1/alternate","shared-asset@v3/tiles","shared-asset@v3/preview"]);
    assert.equal(services.size,5);assert.equal(new Set(services.values()).size,5);
    for(const group of ["shared-asset@v1/preview","shared-asset@v2/preview","shared-asset@v1/alternate","shared-asset@v3/preview"])assert.deepEqual(reads.filter(read=>read.group===group).map(read=>read.url),Object.values(faces));
    assert.equal(reads.length,24);assert.equal(closed,24);assert.notEqual(handles[0].source.texture,handles[1].source.texture);assert.notEqual(handles[0].source.texture,handles[2].source.texture);
    assert.equal(repeated.source.texture,handles[0].source.texture);assert.equal(networkCalls,0);assert.equal(fallbackCalls,0);
    assert.equal(resources.warm(placed("v3"),{headingDeg:0,pitchDeg:0,verticalFovDeg:60}).key,handles[3].key);
    assert.equal(broker.pools.stats().sourceGpu.reserved,96+tileAtlasLayout(tiles,4096,4096).gpuBytes);
  }finally{for(const handle of handles)handle.release();cache.dispose();broker.dispose();}
  for(let n=0;n<20;n++)await Promise.resolve();assert.deepEqual(broker.pools.live(),[]);
}
const {createImageViewer}=await import("@foss-earth/sphere-image/viewer"),engine=await import("@foss-earth/engine/core");
let released=0,detached=0,framesHeld=0;const abort=new AbortController(),hold=()=>{framesHeld++;let live=true;return()=>{if(live){live=false;framesHeld--;}};};
const lease={overview:{version:1,view:{lonDeg:0,latDeg:0,headingDeg:0,pitchDeg:0,zoomMeters:100},camera:{center:{x:0,y:0,z:0},yaw:0,pitch:Math.PI/2,radius:100,fov:Math.PI/3}},signal:abort.signal,released:false,setPresentationView(){},holdRendering:hold,release(){this.released=true;abort.abort();}};
let residencyChoice=null;
let acquire=async()=>({representation:input.asset.representations[0],source:{texture:{},kind:"cube"},release(){released++;},settleReplacement(){}});
const viewerOptions={renderer:{available:true,unavailableReason:null,addOrb(id){return{id,update(){},setExpansion(){},effectiveRadius:()=>1,dispose(){}};},immersion:{show(){},visible:false},setAppearance(){},cameraFrame:()=>({eye:[6378147,-100,0],view:{forward:[0,1,0],right:[0,0,-1],up:[1,0,0],verticalFovRad:Math.PI/3,aspect:1.6},viewportHeightCssPx:900,revision:"fixture",viewRotProj:{},inverseViewRotProj:{}}),pick:()=>[],project:()=>null},resources:{preview:()=>({representation:input.asset.representations[0],limitation:null}),immersion:()=>residencyChoice,acquire:(...args)=>acquire(...args),faceTexels:()=>8},world:{levelUp:engine.levelUp,orbitAngles:engine.orbitAngles,orbitLook:engine.orbitLook,pointGeodetic:engine.pointGeodetic,glideSettling:engine.glideSettling},poses:{viewFromPresentation:()=>({headingDeg:0,pitchDeg:0,rollDeg:0,verticalFovDeg:60}),presentationFromView:()=>({position:{x:1,y:0,z:0},forward:{x:0,y:1,z:0},up:{x:1,y:0,z:0},verticalFovRad:Math.PI/3})},navigation:{acquire:()=>({ok:true,lease}),place(){},restore(){},glide(){},inertiaDecay:()=>.82,returnFocus(){}},input:{cancelOnInput:()=>({stop(){},press:()=>null}),attach:()=>({detach(){detached++;}})},settings:()=>({appearance:{previewFovDeg:90,markerDiameterCssPx:{min:24,max:96},hitTargetDiameterCssPx:44},look:{dragSensitivity:.15,swipeSensitivity:.15,lookRate:90,zoomPerNotch:.1,zoomRate:.5,pinchGain:1,inertiaHalfLifeMs:100,fovRangeDeg:{min:35,max:90},pitchRangeDeg:{min:-85,max:85},reducedMotion:false},entryOrientation:"geographic",flightDurationMs:0,expandDurationMs:0,fadeDurationMs:0,reducedFadeDurationMs:0,orientDurationMs:0,hoverDurationMs:0,previewHoldMs:null}),now:()=>0,devicePixelsPerCss:()=>1,createAbortController:()=>new AbortController(),requestRender(){},holdRendering:hold,isOccluded:()=>false};const viewer=createImageViewer(viewerOptions);
assert.deepEqual(viewer.currentSources("placed"),{preview:null,shown:null});assert.deepEqual(viewer.describeResources("placed"),{previewDetail:null});
assert.equal(viewer.isPlacementFrozen("placed"),false);
const prepared=await viewer.prepare(input,new AbortController().signal);await prepared.ready();
assert.deepEqual(viewer.currentSources("placed"),{preview:null,shown:null});assert.deepEqual(viewer.describeResources("placed"),{previewDetail:null});
viewer.replaceImages([prepared]);
assert.deepEqual(viewer.currentSources("placed"),{preview:input.asset.representations[0].id,shown:null});
assert.deepEqual(viewer.describeResources("placed"),{previewDetail:{representation:input.asset.representations[0].id,faceTexels:8,limitation:null}});
const residencyWhole=input.asset.representations.find(record=>record.projection==="equirectangular");assert(residencyWhole);let residencyWholeReleased=0;
residencyChoice={representation:residencyWhole,limitation:null};
acquire=async()=>({representation:residencyWhole,source:{texture:{},kind:"equirectangular"},release(){residencyWholeReleased++;},settleReplacement(){}});
assert.equal(await viewer.enter("placed"),true);
assert.equal(viewer.isPlacementFrozen("placed"),true);
for(let n=0;n<20;n++)await Promise.resolve();
assert.deepEqual(viewer.currentSources("placed"),{preview:input.asset.representations[0].id,shown:residencyWhole.id});
const residencyTile=input.asset.representations.find(record=>record.projection==="tiled-cube");assert(residencyTile);
let residencyCovered=false,residencyReleased=0;
residencyChoice={representation:residencyTile,limitation:null};
acquire=async()=>({representation:residencyTile,source:{texture:{label:"private-borrowed-cube"},kind:"tiles"},viewReady:()=>residencyCovered,detail:()=>({representation:"private-borrowed-cube"}),release(){residencyReleased++;},settleReplacement(){}});
viewer.onFrame({now:0,dtMs:0});for(let n=0;n<20;n++)await Promise.resolve();
assert.deepEqual(viewer.currentSources("placed"),{preview:input.asset.representations[0].id,shown:residencyWhole.id});
assert.equal(viewer.describeResources("placed").previewDetail.representation,input.asset.representations[0].id);
residencyCovered=true;viewer.onFrame({now:0,dtMs:0});for(let n=0;n<20;n++)await Promise.resolve();
assert.deepEqual(viewer.currentSources("placed"),{preview:input.asset.representations[0].id,shown:residencyTile.id});
assert.equal(residencyWholeReleased,1);
assert.deepEqual(viewer.currentSources("private-borrowed-cube"),{preview:null,shown:null});residencyChoice=null;
viewer.exit();for(let n=0;n<20;n++)await Promise.resolve();assert.equal(viewer.status().phase,"overview");assert.equal(detached,1);
assert.equal(residencyReleased,1);assert.deepEqual(viewer.currentSources("placed"),{preview:input.asset.representations[0].id,shown:null});assert.equal(viewer.isPlacementFrozen("placed"),false);
let resolveLate;acquire=()=>new Promise(resolve=>{resolveLate=resolve;});const stale=await viewer.prepare({...input,id:"stale"},new AbortController().signal),ready=stale.ready();const failure=assert.rejects(ready);for(let n=0;n<5;n++)await Promise.resolve();stale.dispose();resolveLate({representation:input.asset.representations[0],source:{texture:{},kind:"cube"},release(){released++;},settleReplacement(){}});await failure;assert.deepEqual(viewer.currentSources("stale"),{preview:null,shown:null});assert.deepEqual(viewer.describeResources("stale"),{previewDetail:null});viewer.dispose();assert.deepEqual(viewer.currentSources("placed"),{preview:null,shown:null});assert.equal(released,2);assert.equal(framesHeld,0);
{
  const {createImageSessionBroker,createImageSourceCache}=await import("@foss-earth/images");
  const tiled=input.asset.representations.find(record=>record.projection==="tiled-cube");assert(tiled);
  async function warmingCase(pending,cancelled,motion){
    const broker=createImageSessionBroker({requests:1,decodes:1,pools:{encoded:1024,decoded:1024,sourceGpu:1024,overlap:1024,uploadOutstanding:1024}});
    const cache=createImageSourceCache({broker,keptGpuBytes:0,gpuBytes:value=>value.gpuBytes});
    let resolveReady,allocations=0,retired=0,scope=null,clock=0,continuous=0,ticks=0;
    const ready=new Promise(resolve=>{resolveReady=resolve;}),calls=[],virtualFrames=[],cancelControllers=[];
    const keepRendering=()=>{continuous++;let ended=false;return()=>{if(!ended){ended=true;continuous--;}};};
    const controller=new AbortController(),navigationLease={...lease,signal:controller.signal,released:false,holdRendering:keepRendering,release(){this.released=true;controller.abort();}};
    const options={...viewerOptions,now:()=>clock,holdRendering:keepRendering,
      renderer:{...viewerOptions.renderer,cameraFrame(view){if(view)virtualFrames.push(view);return viewerOptions.renderer.cameraFrame(view);}},
      navigation:{...viewerOptions.navigation,acquire:()=>({ok:true,lease:navigationLease})},
      input:{cancelOnInput(value){cancelControllers.push(value);return{stop(){},press:()=>null};},attach:()=>({detach(){}})},
      settings:()=>({...viewerOptions.settings(),flightDurationMs:motion==="flight"?100:0,expandDurationMs:motion?100:0}),
      resources:{preview:()=>({representation:input.asset.representations[0],limitation:null}),faceTexels:()=>8,
        warm:()=>({representation:tiled,limitation:null,key:"warming@v1"}),immersion:()=>({representation:tiled,limitation:null,key:"warming@v1"}),
        async acquire(_input,choice,request){
          if(choice.representation.projection!=="tiled-cube")return{representation:choice.representation,source:{texture:{},kind:"cube"},release(){},settleReplacement(){}};
          calls.push(request);
          const held=await cache.acquire("warming@v1",{...request,estimatedGpuBytes:128,async load(operation,policy){
            scope=operation;const grant=operation.reserve("sourceGpu",128,"installed warming fixture allocation",{overlap:policy.overlap}),keep=grant.retain();allocations++;let ended=false;
            const resource={representation:tiled,key:"warming@v1",gpuBytes:128,source:{texture:{},kind:"tiles"},isCurrent:()=>operation.isCurrent(),onFrame(){ticks++;return false;},settleReplacement:()=>grant.settle(),dispose(){if(ended)return;ended=true;retired++;try{keep();}finally{grant.release();}}};
            if(pending)await ready;
            return resource;
          }});
          return{...held.resource,release:()=>held.release(),settleReplacement:()=>held.settleReplacement()};
        }}};
    const warmed=createImageViewer(options),placed={...input,id:"warmed",placement:{...input.placement,marker:motion?[6378147,0,0]:null}};
    const prepared=await warmed.prepare(placed,new AbortController().signal);await prepared.ready();warmed.replaceImages([prepared]);
    const entering=warmed.enter("warmed",{view:{headingDeg:123,pitchDeg:7,verticalFovDeg:55}});for(let n=0;n<20;n++)await Promise.resolve();
    assert.equal(allocations,1);assert.equal(calls[0].priority,5);assert.equal(calls[0].overlap,true);
    if(motion){
      assert.equal(warmed.status().phase,"entering");assert.equal(warmed.isPlacementFrozen("warmed"),true);assert.equal(warmed.currentSources("warmed").shown,null);
      clock=40;warmed.onFrame({now:clock,dtMs:40});for(let n=0;n<20;n++)await Promise.resolve();
      if(!pending){assert(ticks>0);assert(virtualFrames.length>0);assert.equal(continuous,1);}
    }
    if(cancelled){
      cancelControllers.at(-1).abort(new Error("fresh host input"));for(let n=0;n<20;n++)await Promise.resolve();assert.equal(await entering,false);
      assert.equal(scope.isCurrent(),false);assert.equal(retired,0);assert.equal(broker.pools.stats().sourceGpu.reserved,128);
      resolveReady();for(let n=0;n<20;n++)await Promise.resolve();assert.equal(retired,1);assert.equal(warmed.currentSources("warmed").shown,null);
    }else{
      if(motion){clock=100;warmed.onFrame({now:clock,dtMs:60});for(let n=0;n<20;n++)await Promise.resolve();}
      assert.equal(await entering,true);for(let n=0;n<20;n++)await Promise.resolve();
      if(pending){assert.deepEqual(calls.map(request=>request.priority),[5,10]);assert.equal(calls[0].signal.aborted,true);assert.equal(scope.isCurrent(),true);assert.equal(cache.stats().waiting,1);assert.equal(warmed.currentSources("warmed").shown,input.asset.representations[0].id);resolveReady();for(let n=0;n<20;n++)await Promise.resolve();}
      else assert.equal(calls.length,1);
      assert.equal(warmed.currentSources("warmed").shown,tiled.id);assert.equal(allocations,1);assert.equal(cache.stats().heldReferences,1);assert.equal(broker.pools.stats().overlap.reserved,0);
    }
    warmed.dispose();cache.dispose();broker.dispose();for(let n=0;n<20;n++)await Promise.resolve();
    assert.equal(retired,1);assert.equal(continuous,0);assert.deepEqual(broker.pools.live(),[]);
  }
  await warmingCase(false,false,"flight");await warmingCase(false,false,"expansion");await warmingCase(true,false,false);await warmingCase(true,true,"expansion");
}
{
  // The real installed common cache holds atlas and cube independently. The
  // host reading is actual public viewer residency, never private preparation.
  const {createImageSessionBroker,createImageSourceCache}=await import("@foss-earth/images");
  const {createImageFileService}=await import("@foss-earth/images/browser");
  const {tileAtlasLayout}=await import("@foss-earth/sphere-tiled-cubemap");
  const {createViewerResources}=await import("@foss-earth/sphere-image/resources");
  const leaves=error=>error instanceof AggregateError?Array.from(error.errors).flatMap(leaves):[error];
  async function fallbackCase(mode){
    const broker=createImageSessionBroker({requests:2,decodes:1,pools:{encoded:1000,decoded:1000,sourceGpu:1e6,overlap:1e6,uploadOutstanding:1000}});
    const cache=createImageSourceCache({broker,keptGpuBytes:mode==="cancel"||mode==="throw"?0:1e6,gpuBytes:source=>source.gpuBytes});
    const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,0,0,0,0]);
    const cube=id=>({id,role:"preview",projection:"cube",mimeType:"image/png",encodedBytes:198,faceSize:1,faces:Object.fromEntries(["px","nx","py","ny","pz","nz"].map(face=>[face,`https://fixture.invalid/${id}/${face}`]))});
    const first=cube("first"),published=cube("published"),privatePreview=cube("private");
    const tiles={id:"tiles",role:"immersion",projection:"tiled-cube",mimeType:"image/png",encodedBytes:126,warp:"gnomonic",faceSize:8,tileSize:2,gutter:0,levelBytes:[6,24,96],url:"https://fixture.invalid/tiles/"};
    const placed={...input,id:"fallback",asset:{...input.asset,id:"fallback-asset",revision:"v1",representations:[first,published,privatePreview,tiles]}};
    const reads=[],textures=new Map(),events=[],loadErrors=[],releaseErrors=[new Error("atlas release"),new Error("preview release")],settleErrors=[new Error("atlas settle"),new Error("preview settle")],calls=[];
    let owner,selected=published,atlases=0,decoded=0,closed=0,resolveReady,resolveUploading,resolveLoadFailed;const uploading=new Promise(resolve=>{resolveUploading=resolve;});const loadFailed=new Promise(resolve=>{resolveLoadFailed=resolve;});const ready=new Promise(resolve=>{resolveReady=resolve;});
    const outputError=new Error("late output disposal"),inputError=new Error("late decoded input close");
    const files=createImageFileService({broker,priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000}),fetch:async url=>{reads.push(String(url));return new Response(png,{headers:{"content-type":"image/png"}});},decode:async()=>{const index=decoded++;return{width:1,height:1,close(){closed++;if(mode==="cancel"&&index===0)throw inputError;}};}});
    const tracked={...cache,async acquire(key,request){
      const held=await cache.acquire(key,{...request,async load(scope,policy){try{return await request.load(scope,policy);}catch(error){loadErrors.push(error);resolveLoadFailed();throw error;}}});
      if(mode!=="throw")return held;const tile=held.resource.representation.projection==="tiled-cube",index=tile?0:1;
      return{...held,release(){held.release();calls.push(tile?"atlas release":"preview release");throw releaseErrors[index];},settleReplacement(){held.settleReplacement();calls.push(tile?"atlas settle":"preview settle");throw settleErrors[index];}};
    }};
    const ports={broker,cache:tracked,files,atlasDevice:{},uploader:{async upload(request){resolveUploading();if(mode==="cancel")await ready;const texture={label:request.label};textures.set(request.label,texture);let ended=false;return{kind:"cube",width:1,height:1,levels:1,gpuBytes:24,texture,complete:true,dispose(){if(ended)return;ended=true;events.push("cube");if(mode==="cancel")throw outputError;}};},pump:()=>0,busy:()=>false,setLimits(){},stats:()=>({queuedJobs:0,outstandingBytes:0,lastFrameBytes:0,uploadedBytes:0,publishedCompletionFailures:0,lastPublishedCompletionFailure:null}),cancelAll(){}},
      previewSheetsEnabled:()=>false,maxTextureSide:()=>4096,whenReady:async()=>{},estimate:record=>({encoded:0,decoded:0,sourceGpu:record.projection==="tiled-cube"?tileAtlasLayout(record,4096,4096).gpuBytes:24,uploadOutstanding:0}),
      choice:{preview:()=>({representation:selected,limitation:null}),immersion:()=>null,faceTexels:()=>1},
      tiles:{memoryBytes:()=>4096,limits:()=>({requests:1,waiting:1,decodes:1,uploadsPerFrame:1,retries:0,retryDelayMs:1,fadeMs:0}),selection:()=>({texelsPerPixel:1,marginDeg:0,levelCap:0}),outlines:()=>false},
      createAtlas:({layout})=>{atlases++;return{layout,atlas:{},table:{},beginUpdate:()=>true,endUpdate(){},uploadTile:()=>true,setTable:()=>true,dispose(){events.push("atlas");}};},devicePixelsPerCss:()=>1,requestRender(){},
      previewForTiles(placed){const current=owner.describeImage(placed.id),representation=owner.currentSources(placed.id).preview;return current&&representation?{asset:{id:current.asset.id,revision:current.asset.revision},representation}:null;}};
    const resources=createViewerResources(ports);owner=createImageViewer({...viewerOptions,resources});
    const acquire=(signal=new AbortController().signal)=>resources.acquire(placed,{representation:tiles,limitation:null},{signal,priority:5,overlap:true});
    if(mode==="published"){
      const initial=await owner.prepare(placed,new AbortController().signal);await initial.ready();owner.replaceImages([initial]);
      const a=await acquire();assert.equal(a.source.texture,textures.get("fallback-asset/published"));assert.equal(atlases,1);assert.equal(cache.stats().heldReferences,3);a.release();assert.equal(cache.stats().heldReferences,1);
      selected=privatePreview;const hidden=await owner.prepare(placed,new AbortController().signal);await hidden.ready();const excluded=await acquire();assert.equal(excluded.source.texture,a.source.texture);assert.notEqual(excluded.source.texture,textures.get("fallback-asset/private"));excluded.release();hidden.dispose();
      selected=first;const replacement=await owner.prepare(placed,new AbortController().signal);await replacement.ready();owner.replaceImages([replacement]);initial.dispose();const b=await acquire();assert.equal(b.source.texture,textures.get("fallback-asset/first"));assert.notEqual(b.source.texture,a.source.texture);assert.equal(b.source.tiles.atlas,a.source.tiles.atlas);assert.equal(atlases,1);b.release();assert.equal(cache.stats().heldReferences,1);owner.dispose();assert.equal(cache.stats().heldReferences,0);assert.equal(cache.stats().keptGpuBytes,tileAtlasLayout(tiles,4096,4096).gpuBytes+72);cache.setKeptGpuBytes(0);
    }else if(mode==="cancel"){
      const abort=new AbortController(),work=acquire(abort.signal),observed=work.catch(error=>error);await uploading;assert.equal(broker.pools.stats().decoded.reserved,24);assert.equal(closed,0);
      const reason=new Error("cancelled tiled acquisition");abort.abort(reason);assert.equal(await observed,reason);assert.equal(cache.stats().heldReferences,0);assert.deepEqual(events,["atlas"]);assert.equal(broker.pools.stats().decoded.reserved,24);
      resolveReady();await loadFailed;for(let n=0;n<20;n++)await Promise.resolve();assert.deepEqual(events,["atlas","cube"]);assert.equal(closed,6);const failure=loadErrors.find(error=>leaves(error).includes(outputError));assert(failure);const errors=leaves(failure);assert(errors.indexOf(outputError)<errors.indexOf(inputError));
    }else if(mode==="throw"){
      const source=await acquire();assert.throws(()=>source.settleReplacement(),error=>{assert.deepEqual(leaves(error),settleErrors);return true;});assert.equal(broker.pools.stats().overlap.reserved,0);source.settleReplacement();
      assert.throws(()=>source.release(),error=>{assert.deepEqual(leaves(error),releaseErrors);return true;});source.release();assert.deepEqual(calls,["atlas settle","preview settle","atlas release","preview release"]);assert.equal(cache.stats().heldReferences,0);
    }else{
      let sharperCalls=0;ports.choice.preview=()=>{sharperCalls++;return{representation:privatePreview,limitation:null};};
      if(mode==="omitted")delete ports.previewForTiles;
      else ports.previewForTiles=()=>mode==="null"?null:{asset:{id:mode==="foreign-asset"?"elsewhere":placed.asset.id,revision:mode==="stale-revision"?"v0":placed.asset.revision},representation:mode==="private-id"?"not-declared":published.id};
      const source=await acquire();assert.equal(source.source.texture,textures.get("fallback-asset/first"));assert.equal(sharperCalls,0);assert.deepEqual(reads,Object.values(first.faces));source.release();assert.equal(cache.stats().heldReferences,0);
    }
    owner.dispose();cache.dispose();broker.dispose();for(let n=0;n<20;n++)await Promise.resolve();assert.deepEqual(broker.pools.live(),[]);
  }
  for(const mode of ["published","omitted","null","stale-revision","foreign-asset","private-id","throw","cancel"])await fallbackCase(mode);
}
{
  // Actual installed Images cache, scopes and grants retain published ownership
  // even if supplied cleanup wrappers throw after doing their real operation.
  const {createImageSessionBroker,createImageSourceCache}=await import("@foss-earth/images");
  const {setImmediate}=await import("node:timers");
  const leaves=error=>error instanceof AggregateError?Array.from(error.errors).flatMap(leaves):[error];
  async function settlementCase(mode){
    const broker=createImageSessionBroker({requests:1,decodes:1,pools:{encoded:1024,decoded:1024,sourceGpu:1024,overlap:1024,uploadOutstanding:1024}});
    const cache=createImageSourceCache({broker,keptGpuBytes:0,gpuBytes:resource=>resource.gpuBytes});
    const record=(id,role,projection="cube")=>({id,role,projection,mimeType:"image/png",encodedBytes:60});
    const preview=record("preview-24","preview"),whole=record("whole-64","immersion"),tiles=record("tiles-128","immersion","tiled-cube");
    const placed={...input,id:"settlement",asset:{...input.asset,id:"settlement-asset",revision:"v1",representations:[preview,whole,tiles]}};
    const scopes=new Map(),grants=new Map(),textures=new Map(),disposed=new Map(),released=new Map(),settled=new Map(),events=[],failures=[];
    const outgoingError=new Error("outgoing wrapper after actual cache release"),settlementError=new Error("incoming wrapper after actual grant settlement");
    const publicationError=new Error("incoming final show"),restorationError=new Error("outgoing restoration show"),incomingReleaseError=new Error("incoming wrapper after actual private cache release");
    let desired=whole,armed=false,drawn=null,resolveFailure,resolveWhole,activeHolds=0;
    const failed=new Promise(resolve=>{resolveFailure=resolve;}),wholePublished=new Promise(resolve=>{resolveWhole=resolve;});
    const bump=(map,id)=>map.set(id,(map.get(id)??0)+1);
    const keepRendering=()=>{activeHolds++;let ended=false;return()=>{if(!ended){ended=true;activeHolds--;}};};
    const navigationAbort=new AbortController();
    const navigationLease={...lease,signal:navigationAbort.signal,released:false,holdRendering:keepRendering,setPresentationView(){},release(){if(this.released)return;this.released=true;navigationAbort.abort();}};
    const resources={preview:()=>({representation:preview,limitation:null}),immersion:()=>({representation:desired,limitation:null}),faceTexels:()=>64,
      async acquire(_input,choice,request){
        const record=choice.representation,bytes=record.id===preview.id?24:record.id===whole.id?64:128;
        const held=await cache.acquire(record.id,{...request,estimatedGpuBytes:bytes,async load(scope,policy){
          const grant=scope.reserve("sourceGpu",bytes,record.id,{overlap:policy.overlap});scopes.set(record.id,scope);grants.set(record.id,grant);
          const texture={label:record.id};textures.set(record.id,texture);let ended=false;
          return{representation:record,gpuBytes:bytes,source:{texture,kind:record.id===tiles.id?"tiles":"cube"},isCurrent:()=>scope.isCurrent(),
            dispose(){if(ended)return;ended=true;bump(disposed,record.id);events.push(`${record.id}:dispose`);},
            settleReplacement(){grant.settle();bump(settled,record.id);events.push(`${record.id}:settle`);if(record.id===tiles.id&&armed&&mode==="published")throw settlementError;}};
        }});
        let ended=false;
        return{representation:record,source:held.resource.source,isCurrent:held.resource.isCurrent,viewReady:()=>true,
          release(){if(ended)return;ended=true;held.release();bump(released,record.id);events.push(`${record.id}:release`);if(armed&&mode==="published"&&record.id===whole.id)throw outgoingError;if(armed&&mode==="private"&&record.id===tiles.id)throw incomingReleaseError;},
          settleReplacement:()=>held.settleReplacement()};
      }};
    const options={...viewerOptions,resources,holdRendering:keepRendering,settings:()=>({...viewerOptions.settings(),previewHoldMs:null}),
      renderer:{...viewerOptions.renderer,immersion:{visible:false,show(next){
        if(armed&&mode==="private"&&next&&!next.next){
          if(next.source.texture===textures.get(tiles.id)){events.push("incoming:show-throw");throw publicationError;}
          if(next.source.texture===textures.get(whole.id)){events.push("outgoing:restore-throw");throw restorationError;}
        }
        drawn=next?.source.texture??null;
      }}},
      navigation:{...viewerOptions.navigation,acquire:()=>({ok:true,lease:navigationLease})},
      input:{cancelOnInput:()=>({stop(){},press:()=>null}),attach:()=>({detach(){}})},
      failure(_input,kind,error){if(kind==="image"){failures.push(error);resolveFailure(error);}}};
    const owner=createImageViewer(options),off=owner.subscribe(()=>{if(owner.currentSources(placed.id).shown===whole.id)resolveWhole();});
    try{
      const prepared=await owner.prepare(placed,new AbortController().signal);await prepared.ready();owner.replaceImages([prepared]);assert.equal(await owner.enter(placed.id),true);await wholePublished;
      // One host turn after actual publication completes the prior finalizer;
      // the next refinement starts from an explicitly supplied host frame.
      await new Promise(resolve=>setImmediate(resolve));events.length=0;
      assert.equal(broker.pools.stats().sourceGpu.reserved,88);assert.equal(cache.stats().heldReferences,2);
      armed=true;desired=tiles;owner.onFrame({now:0,dtMs:0});const failure=await failed;
      if(mode==="published"){
        assert.deepEqual(leaves(failure),[outgoingError,settlementError]);assert.deepEqual(events,["whole-64:dispose","whole-64:release","tiles-128:settle"]);
        assert.deepEqual(owner.currentSources(placed.id),{preview:preview.id,shown:tiles.id});assert.equal(drawn,textures.get(tiles.id));
        assert.equal(scopes.get(tiles.id).isCurrent(),true);assert.equal(scopes.get(whole.id).isCurrent(),false);assert.equal(grants.get(whole.id).released,true);
        assert.equal(disposed.get(whole.id),1);assert.equal(disposed.get(tiles.id)??0,0);assert.equal(released.get(whole.id),1);assert.equal(released.get(tiles.id)??0,0);assert.equal(settled.get(tiles.id),1);
        assert.equal(broker.pools.stats().sourceGpu.reserved,152);assert.deepEqual(broker.pools.live().map(grant=>[grant.label,grant.bytes,grant.overlap]),[[preview.id,24,false],[tiles.id,128,false]]);
      }else{
        assert.deepEqual(leaves(failure),[publicationError,restorationError,incomingReleaseError]);assert.deepEqual(events,["incoming:show-throw","outgoing:restore-throw","tiles-128:dispose","tiles-128:release"]);
        assert.deepEqual(owner.currentSources(placed.id),{preview:preview.id,shown:whole.id});assert.equal(drawn,textures.get(whole.id));
        assert.equal(scopes.get(whole.id).isCurrent(),true);assert.equal(scopes.get(tiles.id).isCurrent(),false);assert.equal(grants.get(tiles.id).released,true);
        assert.equal(disposed.get(tiles.id),1);assert.equal(released.get(tiles.id),1);assert.equal(settled.get(tiles.id)??0,0);assert.equal(disposed.get(whole.id)??0,0);assert.equal(released.get(whole.id)??0,0);
        assert.equal(broker.pools.stats().sourceGpu.reserved,88);assert.deepEqual(broker.pools.live().map(grant=>[grant.label,grant.bytes,grant.overlap]),[[preview.id,24,false],[whole.id,64,false]]);
      }
      assert.equal(cache.stats().heldReferences,2);assert.equal(broker.pools.stats().overlap.reserved,0);assert.equal(activeHolds,0);assert.deepEqual(failures,[failure]);
    }finally{off();owner.dispose();cache.dispose();broker.dispose();}
    assert.equal(disposed.get(preview.id),1);assert.equal(disposed.get(whole.id),1);assert.equal(disposed.get(tiles.id),1);assert.equal(cache.stats().heldReferences,0);assert.deepEqual(broker.pools.live(),[]);assert.equal(activeHolds,0);
  }
  await settlementCase("published");await settlementCase("private");
}
const tabs=createViewerTabs({document:doc,viewer:{status:()=>({phase,active:"placed",target:null}),subscribe(fn){subscriber=fn;return()=>{stopped++;};},exit(){phase="overview";subscriber({phase,active:null,target:null});},activateAction:async()=>false},image:()=>input,sectionTitle:(_tab,section)=>section,parameterSection({main}){const element=doc.createElement("div");if(main)element.append(main);return{element,destroy:()=>{}};},sections(entries){const element=doc.createElement("div");element.append(...entries.map(entry=>entry.element));return{element,destroy:()=>{}};},representationText:record=>record.id,detail:()=>null,helpTooltip({label,content}){const element=doc.createElement("span"),button=doc.createElement("button");button.setAttribute("aria-label",label);element.append(button,content);return{element,destroy:()=>{}};},iconButton({label}){const button=doc.createElement("button");button.setAttribute("aria-label",label);return button;}});
assert.equal(tabs.getSnapshot().title,"Published image");assert.doesNotMatch(tabs.sphere.textContent,/Injected photographer|Taken at|Pose:/);assert.equal(input.credits.text,"Injected photographer");tabs.leave();assert.equal(tabs.getSnapshot().title,null);tabs.destroy();tabs.destroy();assert.equal(stopped,1);
console.log("360 installed exports, pure import, preparation CLI and injected panel lifecycle passed");
