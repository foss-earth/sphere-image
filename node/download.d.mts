export interface DownloadOptions {
  source: { photoId: string; url?: never } | { url: string; photoId?: never };
  out: string;
  accessToken?: string;
  maxBytes?: number;
  fetch?: typeof globalThis.fetch;
}
export interface DownloadedPanorama { input: string; directory: string; provenance: Record<string, unknown>; poseFile?: string }
export function downloadPanorama(options: DownloadOptions): Promise<DownloadedPanorama>;
export function listOwnStreetViewPhotos(options?: { accessToken?: string; pageToken?: string; filter?: string; fetch?: typeof globalThis.fetch }): Promise<{photos: Record<string, unknown>[]; nextPageToken?: string}>;
export function downloadAndPreparePanorama(options: DownloadOptions & { prepareOut: string; attribution: string; pose?: string; prepareArgs?: string[]; ownerDirectory?: string; log?(text:string):void }): Promise<{ original:DownloadedPanorama; prepared:import('./preparation.mjs').PreparedSphere }>;
