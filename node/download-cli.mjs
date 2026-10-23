#!/usr/bin/env node
import { downloadAndPreparePanorama, downloadPanorama, listOwnStreetViewPhotos } from './download.mjs';

const HELP = `foss-earth-download-panorama --photo-id OWN_PHOTO_ID --out build/original
  Uses STREETVIEW_PUBLISH_ACCESS_TOKEN (OAuth streetviewpublish scope), never a Maps key.
foss-earth-download-panorama --url https://example.org/my-original.jpg --out build/original
  Use only originals you own or have permission to download and republish.
Add --prepare-out public/media/my-photo --attribution "Photo by ..." [--pose pose.json]
  to prepare previews, a whole-image fallback and EAC tiles with the existing pipeline.
  Arguments after -- override preparation sizes/options, e.g. -- --asset-id my-photo --url-prefix media/my-photo/
Use --list [--page-token TOKEN] [--filter 'placeId=...'] to identify your own Publish photo IDs.
Google Maps/Earth page links are for the embedded viewer, not persistent tile downloading.`;
try {
  const args = process.argv.slice(2), separator = args.indexOf('--');
  const prepareArgs = separator < 0 ? [] : args.splice(separator).slice(1);
  const options = {}, allowed = new Set(['photo-id','url','out','prepare-out','attribution','pose','page-token','filter']);
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--help') { console.log(HELP); process.exit(0); }
    if (args[i] === '--list') { options.list = true; continue; }
    const key = args[i].replace(/^--/,'');
    if (!args[i].startsWith('--') || !allowed.has(key) || args[i+1] === undefined || args[i+1].startsWith('--')) throw new Error('Invalid arguments; use --help.');
    options[key] = args[++i];
  }
  const accessToken = process.env.STREETVIEW_PUBLISH_ACCESS_TOKEN;
  if (options.list) {
    console.log(JSON.stringify(await listOwnStreetViewPhotos({ accessToken, pageToken:options['page-token'], filter:options.filter }), null, 2));
  } else {
    const input = { source:options['photo-id'] ? { photoId:options['photo-id'] } : { url:options.url }, out:options.out, accessToken,
      prepareOut:options['prepare-out'], attribution:options.attribution, pose:options.pose, prepareArgs };
    if (options['photo-id'] && options.url) throw new Error('Choose --photo-id or --url.');
    const result = options['prepare-out'] ? await downloadAndPreparePanorama(input) : await downloadPanorama(input);
    console.log(`Saved original in ${(result.original ?? result).directory}${result.prepared?.out ? `; prepared media in ${result.prepared.out}` : ''}.`);
  }
} catch (error) { console.error(`download-panorama: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
