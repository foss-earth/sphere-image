/** Download originals, never reconstruct Google's public display tiles. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { sniffImage } from '@foss-earth/images/node';
import { prepareSphereAsync } from './preparation.mjs';

const API = 'https://streetviewpublish.googleapis.com/v1/';
const PHOTO_LIMIT = 256 * 1024 * 1024;

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('An image source must be HTTPS without embedded credentials.');
  return url;
}
function tokenHeader(token) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Set STREETVIEW_PUBLISH_ACCESS_TOKEN to an OAuth token with the streetviewpublish scope.');
  return { Authorization: `Bearer ${token}` };
}
async function bounded(response, maxBytes) {
  if (!response.ok) throw new Error(`Image service returned HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) { await response.body?.cancel(); throw new Error('Download exceeds the configured byte limit.'); }
  if (!response.body) throw new Error('Image service returned an empty body.');
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error('Download exceeds the configured byte limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}
async function jsonRequest(url, token, fetcher) {
  const response = await fetcher(url, { headers: tokenHeader(token), redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (response.status === 403) throw new Error('Google denied access. The Publish API downloads only photos created by the authorized user.');
  if (response.status === 401) throw new Error('Google authorization expired or is invalid. Obtain a new streetviewpublish OAuth token.');
  try { return JSON.parse((await bounded(response, 1024 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('The image service returned invalid metadata.'); throw error; }
}
function publicPhoto(photo) {
  return {
    photoId: photo.photoId?.id,
    ...(photo.shareLink ? { shareLink: photo.shareLink } : {}),
    ...(photo.captureTime ? { captureTime: photo.captureTime } : {}),
    ...(photo.pose ? { pose: photo.pose } : {}),
  };
}

/** One explicitly requested page of the authorized user's own photos; no signed URLs returned. */
export async function listOwnStreetViewPhotos({ accessToken, pageToken, filter, fetch: fetcher = globalThis.fetch } = {}) {
  const url = new URL('photos', API);
  url.searchParams.set('view', 'BASIC');
  url.searchParams.set('pageSize', '100');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  if (filter) url.searchParams.set('filter', filter);
  const result = await jsonRequest(url, accessToken, fetcher);
  return { photos: (result.photos ?? []).map(publicPhoto), ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}) };
}

/**
 * source: {photoId} uses Google's owner-authorized Publish API; {url} is an
 * explicitly supplied original the caller has permission to use. No scraping,
 * tile enumeration, automatic account discovery, or OAuth token persistence.
 */
export async function downloadPanorama({ source, out, accessToken, maxBytes = PHOTO_LIMIT, fetch: fetcher = globalThis.fetch }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PHOTO_LIMIT) throw new Error('maxBytes must be between 1 and 256 MiB.');
  if (!out || typeof out !== 'string') throw new Error('An output directory is required.');
  if (!source || Boolean(source.photoId) === Boolean(source.url)) throw new Error('Choose one original URL or one owned Google photo ID.');
  let downloadUrl, provenance, pose;
  if (source.photoId) {
    if (typeof source.photoId !== 'string' || source.photoId.length > 512 || /[\s/\\?#]/.test(source.photoId)) throw new Error('Use the Publish API photo ID, not a Maps page URL.');
    const endpoint = new URL(`photo/${encodeURIComponent(source.photoId)}`, API);
    endpoint.searchParams.set('view', 'INCLUDE_DOWNLOAD_URL');
    const photo = await jsonRequest(endpoint, accessToken, fetcher);
    if (photo.photoId?.id !== source.photoId || !photo.downloadUrl) throw new Error('Google did not return an original for the requested photo.');
    downloadUrl = httpsUrl(photo.downloadUrl);
    if (!/(^|\.)(googleusercontent\.com|googleapis\.com)$/.test(downloadUrl.hostname)) throw new Error('Google returned an unexpected download host.');
    provenance = { kind: 'google-streetview-publish', ...publicPhoto(photo) };
    if (['heading','pitch','roll'].every(field => typeof photo.pose?.[field] === 'number' && Number.isFinite(photo.pose[field]))) {
      pose = { headingDeg: photo.pose.heading, pitchDeg: photo.pose.pitch, rollDeg: ((photo.pose.roll + 180) % 360 + 360) % 360 - 180, provenance: 'Google Street View Publish API pose for the authorized owner photo.' };
    }
  } else {
    downloadUrl = httpsUrl(source.url);
    if (/(^|\.)(google\.com|googleapis\.com|googleusercontent\.com|goo\.gl)$/.test(downloadUrl.hostname)) throw new Error('Use a local original or --photo-id for Google imagery. A Maps display URL is not an original-image download.');
    provenance = { kind: 'original-url', source: `${downloadUrl.origin}${downloadUrl.pathname}` };
  }
  // Do not forward the owner's OAuth credential to an image CDN or redirects.
  const signal = AbortSignal.timeout(60000);
  let response;
  for (let count = 0; count < 6; count++) {
    response = await fetcher(downloadUrl, { redirect:'manual', signal });
    if (![301,302,303,307,308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || count === 5) throw new Error('Original-image redirect could not be resolved.');
    downloadUrl = httpsUrl(new URL(location, downloadUrl).href);
    if (source.photoId && !/(^|\.)(googleusercontent\.com|googleapis\.com)$/.test(downloadUrl.hostname)) throw new Error('Google image redirected to an unexpected host.');
  }
  const bytes = await bounded(response, maxBytes);
  const mimeType = sniffImage(bytes);
  if (!mimeType) throw new Error('The original is not a JPEG or PNG. Maps pages and partial tile downloads cannot be prepared as originals.');
  const directory = path.resolve(out);
  await mkdir(path.dirname(directory), { recursive:true });
  // Own only a new directory so failures cannot overwrite/delete the caller's data.
  await mkdir(directory);
  try {
    const filename = `original.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
    const input = path.join(directory, filename);
    await writeFile(input, bytes, { flag:'wx' });
    const manifest = { ...provenance, downloadedAt:new Date().toISOString(), file:filename, mimeType, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex') };
    await writeFile(path.join(directory, 'source.json'), `${JSON.stringify(manifest,null,2)}\n`, { flag:'wx' });
    let poseFile;
    if (pose) { poseFile = path.join(directory, 'pose.json'); await writeFile(poseFile, `${JSON.stringify(pose,null,2)}\n`, { flag:'wx' }); }
    return { input, directory, provenance:manifest, ...(poseFile ? { poseFile } : {}) };
  } catch (error) { await rm(directory, { recursive:true, force:true }); throw error; }
}

/** Existing preparation owns normalization, coverage checks, EAC reprojection and hashes. */
export async function downloadAndPreparePanorama(options) {
  const args = options.prepareArgs ?? [];
  if (args.some(value => /^--(?:input|out|replace)(?:=|$)/.test(value))) throw new Error('Input/output/replacement are controlled by the download wrapper.');
  if (!options.prepareOut || !options.attribution?.trim()) throw new Error('prepareOut and a photograph attribution are required.');
  if (path.resolve(options.prepareOut) === path.resolve(options.out)) throw new Error('Use separate original and prepared output directories.');
  const original = await downloadPanorama(options);
  const pose = options.pose ?? original.poseFile;
  const prepared = await prepareSphereAsync([
    '--input', original.input, '--out', options.prepareOut, '--attribution', options.attribution,
    '--preview-face-sizes','64,128', '--immersion-widths','2048', '--tiles','eac',
    ...(pose ? ['--pose',pose] : []), ...args,
  ], { ownerDirectory:options.ownerDirectory, log:options.log });
  return { original, prepared };
}
