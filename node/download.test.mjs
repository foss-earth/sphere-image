import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '@foss-earth/images/node';
import { downloadPanorama, downloadAndPreparePanorama, listOwnStreetViewPhotos } from './download.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
await mkdir(path.join(root,'build'),{recursive:true});
const rgb = new Uint8Array(256*128*3);
for(let i=0;i<rgb.length;i+=3) { rgb[i]=i%256; rgb[i+1]=90; rgb[i+2]=130; }
const png = encodePng({width:256,height:128,rgb});
async function fixture(run) {
  const directory = await mkdtemp(path.join(root,'build/download-test-'));
  try { await run(directory); } finally { await rm(directory,{recursive:true,force:true}); }
}
const photo = {photoId:{id:'my-photo'},downloadUrl:'https://lh3.googleusercontent.com/original?signature=private-value',shareLink:'https://www.google.com/maps/@?pano=my-photo',pose:{heading:40,pitch:0,roll:350},captureTime:'2025-01-01T00:00:00Z'};

test('owner photo uses authenticated Publish metadata, unauthenticated original bytes, and redacted provenance', async()=>fixture(async directory=>{
  const calls=[];
  const result=await downloadPanorama({source:{photoId:'my-photo'},out:path.join(directory,'source'),accessToken:'owner-secret',fetch:async(url,options)=>{
    calls.push({url:String(url),options});
    return calls.length===1 ? Response.json(photo) : new Response(png);
  }});
  assert.equal(new URL(calls[0].url).searchParams.get('view'),'INCLUDE_DOWNLOAD_URL');
  assert.equal(calls[0].options.headers.Authorization,'Bearer owner-secret');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[1].options.headers,undefined);
  assert.deepEqual(await readFile(result.input),Buffer.from(png));
  const saved=await readFile(path.join(result.directory,'source.json'),'utf8');
  assert.ok(!saved.includes('owner-secret')&&!saved.includes('signature')&&!saved.includes('downloadUrl'));
  const pose=JSON.parse(await readFile(result.poseFile,'utf8'));
  assert.equal(pose.rollDeg,-10);
  assert.equal(pose.headingDeg,40);
}));

test('owner permission failures and untrusted download hosts produce no files or secret error text', async()=>fixture(async directory=>{
  for (const response of [new Response('',{status:403}),Response.json({...photo,downloadUrl:'https://evil.example/steal'})]) {
    await assert.rejects(downloadPanorama({source:{photoId:'my-photo'},out:path.join(directory,'source'),accessToken:'owner-secret',fetch:async()=>response}),error=>!error.message.includes('owner-secret'));
  }
}));

test('HTML, oversized responses, insecure URLs and Maps display URLs cannot become originals', async()=>fixture(async directory=>{
  for(const response of [new Response('<html>Maps</html>'),new Response(png,{headers:{'content-length':'99999999'}})]) {
    await assert.rejects(downloadPanorama({source:{url:'https://photos.example/original'},out:path.join(directory,'source'),maxBytes:1024,fetch:async()=>response}));
  }
  for(const url of ['http://photos.example/photo.jpg','https://www.google.com/maps/@?pano=id','https://user:secret@photos.example/photo.jpg']) {
    await assert.rejects(downloadPanorama({source:{url},out:path.join(directory,'source'),fetch:async()=>{throw new Error('Must not fetch');}}));
  }
}));

test('streaming limit cancels a response without trusting content-length', async()=>fixture(async directory=>{
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(12));},cancel(){cancelled=true;}});
  await assert.rejects(downloadPanorama({source:{url:'https://photos.example/image'},out:path.join(directory,'source'),maxBytes:8,fetch:async()=>new Response(stream)}),/byte limit/);
  assert.equal(cancelled,true);
}));

test('download refuses to overwrite an existing original directory', async()=>fixture(async directory=>{
  const target=path.join(directory,'existing'); await mkdir(target); await writeFile(path.join(target,'keep.txt'),'keep');
  await assert.rejects(downloadPanorama({source:{url:'https://photos.example/image'},out:target,fetch:async()=>new Response(png)}),/EEXIST/);
  assert.equal(await readFile(path.join(target,'keep.txt'),'utf8'),'keep');
}));

test('listing requests only owner BASIC metadata and strips signed URLs', async()=>{
  let request;
  const result=await listOwnStreetViewPhotos({accessToken:'owner-secret',filter:'placeId=example',fetch:async url=>{request=new URL(url);return Response.json({photos:[photo],nextPageToken:'page2'});}});
  assert.equal(request.searchParams.get('view'),'BASIC'); assert.equal(result.nextPageToken,'page2');
  assert.ok(!JSON.stringify(result).includes('signature'));
});

test('download and preparation produce real EAC tiles through the existing public pipeline', async()=>fixture(async directory=>{
  const pose=path.join(directory,'authored-pose.json');
  await writeFile(pose,JSON.stringify({headingDeg:0,pitchDeg:0,rollDeg:0,provenance:'Synthetic fixture, arbitrary heading, not a survey.'}));
  const result=await downloadAndPreparePanorama({source:{url:'https://photos.example/original.png'},out:path.join(directory,'original'),prepareOut:path.join(directory,'prepared'),pose,attribution:'Synthetic test image',fetch:async()=>new Response(png),log:()=>{},prepareArgs:['--asset-id','test-panorama','--preview-face-sizes','16','--immersion-widths','128','--tile-size','8','--tile-face-size','32','--url-prefix','media/test/']});
  const fragment=JSON.parse(await readFile(path.join(result.prepared.out,'asset.fragment.json'),'utf8'));
  const tiles=fragment.asset.representations.find(value=>value.projection==='tiled-cube');
  assert.equal(tiles.warp,'equi-angular'); assert.equal(tiles.levelBytes.length,3);
  assert.ok((await readFile(path.join(result.prepared.out,'eac-tiles/px/2/0/0.jpg'))).length>0);
  assert.equal(fragment.asset.attribution.text,'Synthetic test image');
}));
