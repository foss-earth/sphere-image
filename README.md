# @foss-earth/sphere-image

Image viewer composition and camera handover for FOSS Earth. It lets a host app enter a 360 degree sphere (an "orb") or a flat image window from the globe, look around, and fly back out. Everything the viewer needs from the host (renderer, resources, input, camera pose, world geography, settings, clock) is passed in through explicit ports.

## What this package owns

- Viewer contracts, orb and window ray mathematics, look and flight models, representation selection, and geographic-heading interpolation.
- The image viewer lifecycle, its resource handling, settings, panel tabs and browser input.
- Orb, reveal and immersion rendering on the host's Babylon.js scene.
- Sphere preparation (a Node API and the `foss-earth-prepare-panorama` command).

Other repositories own related pieces:

- [scenes](https://github.com/foss-earth/scenes): scene documents, placements, history and navigation topology. The viewer never resolves scene entities; scenes supplies activation callbacks.
- [sphere-cubemap](https://github.com/foss-earth/sphere-cubemap), [sphere-equirectangular](https://github.com/foss-earth/sphere-equirectangular), [sphere-tiled-cubemap](https://github.com/foss-earth/sphere-tiled-cubemap) and [preview-sheets](https://github.com/foss-earth/preview-sheets): image acquisition, spatial conventions, uploads, tile layout and preview sheets. No leaf validator or spatial format algorithm is copied here.
- [images](https://github.com/foss-earth/images): the shared broker, source cache and file services.

## Exports

| Entry | Contents |
| --- | --- |
| `.` and `./core` | Pure viewer contracts, ray mathematics, look and flight models, built-in representation composition, selection, heading interpolation. Importing them initializes no DOM, React, renderer, network session or clock. |
| `./viewer` | `createImageViewer` |
| `./resources` | `createViewerResources` |
| `./settings` | `VIEWER_PARAMETERS`, `VIEWER_SECTION_TITLES`, `VIEWER_EXPERIMENT_IDS`, `VIEWER_EXPERIMENT_PARAMETERS` |
| `./panels` | `createViewerTabs` |
| `./input` | Browser input handlers |
| `./babylon`, `./shaders`, `./shaders-webgl` | Orb, reveal and immersion rendering on the host scene |
| `./globe`, `./globe-browser` | Globe bindings |
| `./preparation` (also `./node`) | `prepareSphere(argv, ports)` |
| `./prepare-cli` | The `foss-earth-prepare-panorama` command |

Engine geography is supplied through `ViewerWorldMath` and `ViewerPosePorts`. Production code in this package does not import the engine.

## Image viewer

`createImageViewer` (from `./viewer`) takes the host's renderer, resources, navigation, input and pose ports, settings, cancellation, occlusion and clock/frame authority.

- `prepare(input, signal)` freezes authored metadata and prepares a hidden orb.
- `ready()` waits for a live source and rejects on disposal.
- `replaceImages(handles)` validates the whole next publication before changing visible metadata. The host then disposes the outgoing handles. Internal draw IDs tell old and new sets apart when authored IDs repeat.
- `describeImage(id)` returns immutable metadata for a details panel.
- `enter`, `exit`, `activateAction`, `pick`, `hover`, `subscribe`, `status`, `onFrame` and `dispose` make up the rest of the lifecycle.
- A cancelled flight hands position, velocity, turn and fresh gestures to the host's single camera glide.

The factory returns `PublishedImageViewer`: the `ImageViewer` interface plus `ViewerResourceReadings`.

- `currentSources(id)` reports the published preview and the representation IDs currently shown.
- `describeResources(id).previewDetail` reports the retained preview ID, owner density and limitation from its successful choice.
- `isPlacementFrozen(id)` reads whether the published entry is frozen, so a displayed-ground watcher can keep its original query guard.

Hidden preparation, private incoming or borrowed sources, cancelled or disposed entries and stale generations do not appear in these readings. Reading them creates no resource, draw, subscription or policy change. Plain `ImageViewer` implementations stay valid without the readings. When adapting selection for a prepared replacement that reuses a placed ID, compare `describeImage(id).asset` ID and revision with the input before using residency from the published image.

## Resources

`createViewerResources` (from `./resources`) needs the host's images broker, `createImageSourceCache`, file service, renderer uploader and `atlasDevice` region adapter. It creates no renderer, broker, upload queue, clock or frame subscription. The host pumps its uploader and transfer tracker once per frame and calls the viewer's `onFrame`.

- Upload tickets reserve directly in broker pools and outlive operation cancellation.
- Source holds keep fallback previews alive.
- Replacement overlap settles only after the outgoing source is released, including borrowed previews during interrupted flight outros.
- Cache keys keep the resolved URL order, broker generation and atlas layout.
- A source made stale by broker invalidation cannot stay the active preview. Liveness and key checks reload it and invalidate an immersive navigation hold.

`filesFor(input, representation)` is optional. It selects the file service bound to `mediaGroup(input.asset, representation)`. A host can memoize these services per group and give each `mediaStore.files(group)`, while they all share one broker, transport and decoder. Selection runs once per new cached source, and a cached source keeps its original group. Tiled sources select their tile group, and cube previews acquired from them select their own preview group. Preview sheets use the explicit `PreviewSheetFile.mediaGroup`. A URL is not a media-group identity, because different asset revisions or representations may reuse one. Without `filesFor`, the fixed `files` service is used.

Tiled sources:

- Incoming tiled sources use the host frame through coverage waits and crossfades.
- Tiles over a preview appear immediately, with the preview as fallback. A sharper whole image stays until its replacement covers the current view.
- While the view moves during a fade, fallback pixels can show while new tiles arrive. Final publication rechecks the latest coverage.
- Waiting on network or decode adds no continuous render lease.
- Each tiled acquisition takes its own cube-preview hold. The optional `previewForTiles` supplies the published asset, revision and preview identity. Otherwise the first declared complete cube preview is used. The cached atlas holds no fallback reference, so reusing it with a changed preview does not retain a private fallback or allocate another atlas.
- The optional `warm(input, view)` selector prepares a tiled entry during flight, expansion or fade. The viewer ticks it with the virtual opening view on the host frame and either takes over a ready source hold or joins a pending cache load before cancelling its warming waiter. It adds no renderer, cache, broker, scheduler or rendering hold, and published source readings exclude it.

Refinement commits a successfully displayed incoming source before releasing the outgoing one and settling the replacement. All cleanup calls are attempted and their failures are reported in operation order, while the displayed source keeps its cache hold. If the final display fails before publication, restoration and release of the incoming source are both attempted, and the display, restoration and release errors are reported in order. The [resource contract](docs/saved-media-services.md) documents cancellation, late retirement and the test scope.

## Selection

`createViewerSelection` keeps preview-size bounds, density, the image-detail cap, format preference, fallback when the cache or broker will not admit a source, and exclusion of failed sources. The host supplies owner density and estimate hooks, the currently published IDs, user settings, device limits and the common cache and broker admissibility checks.

`createBuiltInRepresentations` composes the public leaf validators. `validateViewerAsset` requires a validated complete cube preview.

## Settings and panels

`./settings` exports `VIEWER_PARAMETERS` and `VIEWER_SECTION_TITLES`, covering the appearance, motion and active-image parameters with their IDs, homes, bounds, defaults and reasons. `VIEWER_EXPERIMENT_IDS` and `VIEWER_EXPERIMENT_PARAMETERS` cover three experiments: sphere bookkeeping, opaque immersion and shaders. They are included once in `VIEWER_PARAMETERS`, with `renderer.experiments.*` IDs, off by default, with no numeric bounds. They appear under Renderer, Work-saving experiments.

The generic Renderer owns that section and its `all` and `presentationCandidates` records. Register them from Renderer together with this package's records in the host's one parameter registry. The settings entry imports no Renderer code and never registers anything globally. Content controls, images loading and saved controls, tiled-cubemap tile controls (including `tileOutlines`) and the preview-sheets `previewSheets` control belong to scenes and those libraries.

`./panels` exports `createViewerTabs`, which takes an injected document, UI section and parameter adapters, generic image and details readings, and tab activation. The tab IDs are `panorama` and `panorama-settings`. Closing a tab calls exit.

`./input` takes explicit window, control-key and wheel-classifier ports. Detached handlers do nothing.

Panorama drags offer **Looking → Drag → Grab / Scroll**. Grab holds the touched
image point; Scroll maps finger movement directly to heading and pitch wherever
the drag starts. Both keep release inertia. Touch pinches and zooms hold their
image point, while trackpad swipes turn heading and pitch directly. **Looking →
Show anchors** shows map-style markers, off by default. See [panorama gestures
and visible anchors](docs/gesture-anchors.md) for the FOV limits, gesture
lifetime, viewport units and regression coverage.

## Sphere preparation

`prepareSphere(argv, ports)` from `./preparation` (also `./node`), and the `foss-earth-prepare-panorama` command, prepare a sphere from a local file. They take local-file arguments, authored or GPano pose and a mandatory credit. They write dated output under `build/prepared-scenes`: preview, whole and tiled files, plus fragment and provenance outputs. Normalization, source eligibility, sampling, cube and tile rendering and the encoders are public APIs of the owning libraries. Preparation uses no network.

## Earlier package name

This package was named `@foss-earth/360`. Consumers import `@foss-earth/sphere-image`.
Records and documents did not change: the `panorama-image` asset type, the `cube`,
`equirectangular` and `tiled-cube` projections, the representation schemas'
`$id`s and media URLs are as before. The repository is `foss-earth/sphere-image`.

## Development

This package depends on other `@foss-earth/*` libraries by versions that are not published, so its own `npm install`, tests and build do not work on their own yet. Libraries are developed through the app, which uses them straight from their checkouts. See [local source](https://github.com/foss-earth/app#local-source).

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
