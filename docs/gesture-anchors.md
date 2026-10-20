# Panorama gestures and visible anchors

The full panorama and interactive scene previews use the same look model,
following the shared [Physical UX](https://github.com/foss-earth/docs/blob/main/docs/physical-ux.md)
principles across the globe and 360 spheres.
Pointer drags offer **Grab** and **Scroll** modes. Grab moves the touched image
point one CSS pixel per input pixel wherever an upright camera can hold it.
Scroll turns heading and pitch by the drag's movement, independent of where
the finger first touches. Both scale with zoom and keep the same release glide.

## Settings

These controls live in **360 image settings → Looking** unless noted otherwise.

| Setting | Behavior |
| --- | --- |
| `scene.panorama.dragMode` | **Drag → Grab / Scroll**, default Scroll. Applies to one-finger and mouse drags in the full viewer and scene previews. |
| `scene.panorama.verticalFovRange` | Default vertical FOV range 20–140°. Allowed setting bounds 10–150°. |
| `scene.panorama.entryFov` | Default 120°, bounded to 10–150° and the selected zoom range; under Entering. The flight in widens or narrows to it on the way. |
| `scene.panorama.showAnchors` | Show anchors, off by default; independent of the map's `input.showNavigationAnchors`. |
| `scene.panorama.dragSensitivity` | Legacy degrees-per-pixel fallback when there is no measured viewport. |
| `scene.panorama.swipeSensitivity` | Degrees per CSS pixel of a two-finger trackpad swipe at 90° FOV, scaled with $\tan(\text{fov}/2)$. |
| `scene.panorama.inertiaHalfLife` | Glide half-life in ms for drag release, two-finger trackpad swipes, and wheel/pinch zoom. |

## Hold an image point through the gesture

In Grab mode, `createLookModel` in `src/look.ts` casts a common-space ray through the initial
surface-local point. `anchorSphereCamera` solves a legal heading and pitch that
keep that ray at the gesture's desired destination. Pure pans preserve FOV.
Coordinates and viewport dimensions must use the same measured CSS rectangle,
including its offset from the whole canvas. Backing-store resolution and device
pixel ratio do not change these input units.

In Grab mode, a one-finger or mouse drag retains its ray across consecutive moves. Two-touch
pan and pinch retain the ray through the initial midpoint while combining
midpoint motion and separation changes in one camera update.

A two-finger trackpad swipe turns `headingDeg` and `pitchDeg` directly by its
scroll deltas scaled by `swipeSensitivity` and $\tan(\text{fov}/2)$ (`swipeFovScale`),
regardless of cursor position, and shows no anchor marker. Both trackpad swipes
and wheel/pinch zoom feed impulses into the look model's velocity and decay across
frames with `inertiaHalfLife`, matching the map's `InertialCameraController`.

The solver is intended to stop at the last feasible pose near a pitch limit
without rolling the camera or jumping to the other mathematical branch. The
near-pole reversal limitation below remains unresolved. Keep the original ray
when the desired destination becomes unreachable. Its actual projection is
the next solve's source, so reversing the gesture can bring the same point
back. Recasting at the cursor on every event loses this behavior.

## Scroll without a contact anchor

Scroll maps a drag right to decreasing heading and a drag down to increasing
pitch. Equal movements give equal turns at the top, middle and bottom of the
same viewport. It keeps FOV fixed and the horizon upright, and shows no grab
marker. Pinches and zooms still hold their image point.

The measured gain is `2 * tan(verticalFov / 2) / viewportHeight` radians per CSS
pixel: the image's angular scale at the view centre. Zooming in therefore
reduces the turn per pixel. Without a measured viewport, the existing
`dragSensitivity` fallback supplies the gain. At a pitch limit, excess travel
is discarded so the first reverse movement responds immediately.

This mode avoids Grab's geometric limitation: a contact near the screen's top
while looking up, or bottom while looking down, can select a ray near the
sphere's pole. Keeping that ray under arbitrary finger motion while keeping
the horizon upright is not always possible, and heading can become very
sensitive before the exact-contact solve stops.

## Why Scroll became the default

On 19 October 2026, after trying Scroll on an Android phone, the tour's user
reported that it felt much better and requested it as the default, with the
existing inertia retained. The original complaint concerned where the finger
first touched the screen, especially near its top or bottom. This is
**edge-dependent anchor instability**, rather than a universal screen-edge
failure or evidence of lost Android touch events.

Grab ties the camera response to the world direction initially touched.
Looking somewhat up and touching near the top can select a direction close to
the sphere's pole. An upright camera cannot move that fixed direction along
every arbitrary screen path: heading sensitivity grows sharply, then the
exact-contact solution becomes unreachable. This can happen far below the
camera's pitch limit. Looking down and touching near the bottom mirrors it.

A source-model replay made the distinction concrete. With a 390 × 780 CSS-pixel
viewport, vertical FOV 100°, heading 0° and pitch 40°, start at x195 and drag
right by 120 pixels in 2-pixel steps, without releasing:

| Contact y | Grab response | Scroll response |
| --- | --- | --- |
| 78 (top) | Turns 90° and stalls after about 50.45 pixels; pitch reaches 46.37°. | Turns 21.01°, preserving pitch 40°. |
| 390 (middle) | Turns 26.71°; pitch reaches 43.21°. | The same 21.01° turn, preserving pitch 40°. |
| 702 (bottom) | Turns 14.89°; pitch reaches 39.87°. | The same 21.01° turn, preserving pitch 40°. |

The top contact's world latitude is 83.63°, although camera pitch is only 40°.
At a level view, that same horizontal top-edge path tracks correctly in Grab.
The problem depends on contact position, current pitch and FOV together.
Scroll gives predictable horizontal and vertical control throughout the screen
by allowing the originally touched feature to slide. It preserves the upright
horizon, FOV and release glide; exact feature contact is not its invariant.

The default applies in the model, setting catalogue, app adapter and scene
previews. An explicit saved Grab choice still wins. Two-touch pinches and wheel
zoom retain their anchors in either mode. No assumption about Google Maps'
internal implementation is needed for this decision.

### Remaining Grab limitation

In the top-contact replay above, crossing the reachability boundary and then
retracing all the way to the starting pixel can leave Grab at heading 180°,
pitch 52.73°, even though the image anchor returns to its original pixel. Near
the boundary, two inverse-camera solutions meet; choosing the nearest forward
direction does not preserve the gesture's original branch. Scroll bypasses
that solver; it does not fix Grab's branch continuity. Recasting the contact on
every event or replacing angle storage with quaternions alone does not remove
the upright camera's reachability constraint.

These numbers come from the actual `createLookModel` and sphere-camera source,
not an instrumented Android/browser trace. The user's improved phone experience
is qualitative feedback. The regression suite checks default Scroll behavior,
top/middle/bottom equivalence, out-and-back drags, FOV scaling, immediate pitch
reversal and the retained glide. Deployment is a separate action.

## Release glide

While a drag is held, frame ticks do not apply its recorded velocity. On
release, glide uses the camera's actual angular displacement, with heading
wrapped across 0/360°. A stationary release, reduced motion or zero glide
half-life stops immediately. Off-centre wheel and pinch zoom retain the anchor
ray at the pointer throughout their inertial glide.

## Draw the actual point

`LookModel.anchor()` projects the retained ray into surface-local CSS pixels.
`subscribeAnchors()` reports camera changes and gesture transitions, including
glide completion. A marker can lag behind the finger at a pitch limit because
it shows the image point, rather than the pointer position.

The optional `anchorMarkers` input port creates its renderer lazily. The host
setting subscription applies toggles immediately. `createImageAnchorMarkers`
from `./globe-browser` reuses Engine's map grab arrows and zoom reticle, converts
the local projection to client coordinates, and clips outside the measured
surface. A released grab uses the map's gray glide color. Wheel zoom and Safari
pinch markers disappear 180 ms after the last event; trackpad swipes clear any
active marker instead of showing one. Dropping from two touches to
one hides the old midpoint until the remaining finger moves; blur, cancellation
and detach clear the display, timers and subscriptions.

Earth App wires the setting to both its immersive viewer and Scenes previews.
Preview renderers use the iframe canvas's own document and CSS dimensions.
See [globe adapters](globe-bindings.md) for the host ports.

## Regression coverage

- `tests/sphereInput.test.ts`: projection accuracy from 10° to 150° FOV, retained
  rays, pitch-limit reversal, heading wrap, release velocity and unanchored
  trackpad swipes; Scroll position independence, zoom scaling, limits and glide.
- `tests/imageCameraAnchors.test.ts`: projected marker geometry, gesture flags,
  glide, subscriptions and missing-camera/viewport behavior.
- `tests/imageAnchorMarkers.test.ts`: live toggles, unanchored trackpad swipes,
  zoom expiry, absent/disabled markers, touch transitions and cleanup.
- `tests/globeBindings.test.ts`: map styling, measured offsets and iframe realms.
- Earth App's `src/app/sceneWorld.test.ts`: the real settings registry and viewer
  adapter together, including default-off and live enable/disable behavior.

Run linked-library checks with the `source` export condition, as Earth App's
development setup does. An isolated package typecheck can read stale sibling
`dist` declarations; Earth App's `npm run typecheck` checks the linked source
interfaces. The [development setup](../README.md#development) describes the
side-by-side library arrangement.
