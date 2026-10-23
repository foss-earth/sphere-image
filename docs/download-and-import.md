# Download an original and prepare EAC tiles

FOSS Earth's native tour format uses equi-angular **cube** tiles (`eac`), with
cube previews and optional whole equirectangular fallbacks. The source original
is a full 2:1 equirectangular JPEG/PNG. Preparation already handles projection,
colour/orientation checks, tile gutters, levels, encoded byte counts and hashes.

## Your own Google 360 photos

[Street View Publish photo.get](https://developers.google.com/streetview/publish/reference/rest/v1/photo/get)
returns a download URL with `view=INCLUDE_DOWNLOAD_URL`. Google authorizes only
the user who created the photo. Set `STREETVIEW_PUBLISH_ACCESS_TOKEN` in your
local shell to an OAuth access token with
`https://www.googleapis.com/auth/streetviewpublish`; a Maps API key cannot
replace that authorization. The tool does not obtain login credentials or
refresh tokens. Never put tokens in source files, arguments, reports or commits.

```sh
foss-earth-download-panorama --list
foss-earth-download-panorama --photo-id YOUR_OWN_PHOTO_ID --out build/original
```

`--list` requests one page of your own BASIC metadata. Use its `nextPageToken`
with `--page-token` to request another, or `--filter 'placeId=...'`. It returns
IDs, share links and pose, never signed download URLs. A regular flat Google
Maps contribution is not a Publish API panorama; use your local original for
that photograph.

Download and prepare in one command:

```sh
foss-earth-download-panorama --photo-id YOUR_OWN_PHOTO_ID \
  --out build/original --prepare-out public/media/my-photo \
  --attribution "Photo by the photographer" \
  -- --asset-id my-photo --url-prefix media/my-photo/
```

The default preparation is previews 64/128, a whole 2048 image, and EAC tiles.
Arguments after `--` override sizes through the existing preparation parser.
Small originals require correspondingly smaller sizes; detail is never
invented. Supply `--pose pose.json` when the original has no GPano pose and
Google's metadata has no complete heading/pitch/roll. A pose file must explain
its provenance; an arbitrary heading should be identified honestly.

## Other originals and local files

Use only originals you own or have permission to download and republish:

```sh
foss-earth-download-panorama --url https://example.org/my-original.jpg \
  --out build/original
foss-earth-prepare-panorama --input build/original/original.jpg \
  --pose pose.json --attribution "Photo by the photographer" \
  --asset-id my-photo --preview-face-sizes 64,128 \
  --immersion-widths 2048 --tiles eac --url-prefix media/my-photo/ \
  --out public/media/my-photo
```

Use the preparation command directly for originals already on disk. Downloads
are limited to 256 MiB, have timeouts, check actual image signatures, and refuse
existing output directories. The OAuth token is sent only to the Publish API,
not image CDNs or redirects. `source.json` records a checksum and provenance;
it omits signed Google download URLs and the access token. Keep acquisition
outputs under ignored `build/`. Preparation writes `prepared.json` and
`asset.fragment.json` alongside the actual image files.

## Add the prepared panorama to a scene

The browser's **+ → Add image → Prepared panorama** accepts the fragment,
coordinates, an optional existing scene JSON and its published URL. It validates
the result, previews it for the current visit and downloads a scene draft.
Prepared media must also be hosted at the URL used by that draft.

The same operation is available as `foss-earth-add-image` from
`@foss-earth/scenes`, or the pure `addPreparedPanorama` function from
`@foss-earth/scenes/authoring`. See that package's README. Preserve a tour's
authoring inputs rather than editing a generated scene by hand.

## Viewing Google imagery and nearby orbs

**+ → Add image → Google 360°** opens Google's official embedded viewer from a
panorama link/ID or Share → Embed snippet. A panorama ID requires a Google key
with Maps Embed API enabled; an official share embed has its own configuration.
This viewing path does not import the imagery into persistent FOSS storage.

Google's [Street View Tiles API](https://developers.google.com/maps/documentation/tile/streetview)
also supports nearby panorama searches, metadata, thumbnails and streamed
panoramas. That could power an optional map layer with preview orbs. Search
returns the nearest panorama for each sampled point, rather than an exhaustive
list of all uploads. The nearby orb layer is not implemented in this change.
Such a provider must follow Google's attribution and
[cache/storage rules](https://developers.google.com/maps/documentation/tile/policies);
it should not feed public display tiles into the original-download/EAC pipeline.
