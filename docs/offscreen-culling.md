# Off-screen panorama markers, 22 October 2026

Panorama markers now supply Babylon's frustum dispatch with a conservative
test of their actual shader quad. Babylon's ordinary mesh bounds describe the
unpositioned unit quad, so the previous implementation always submitted every
marker. No horizon or terrain-occlusion assumption is used.

The test rejects a quad only when every corner is strictly outside one side
clip half-space or behind the eye. It evaluates the extrema of each affine
plane over the quad. A relative slack bounds shader input and arithmetic
rounding using magnitudes before cancellation; ambiguous, nonfinite and
full-screen cases remain eligible. The z clip convention is irrelevant.
Expansion radius, display scale, outline margin and delayed uniforms all feed
the same `orbQuad` used by the draw. Tracked headset passes retain their previous
eligibility. Mesh visibility and explicit probe meshes are unchanged.

## Measured on the UMN Minneapolis tour

One production build, with culling bypassed by setting the marker meshes'
`alwaysSelectAsActiveMesh` for arm A. Arm B uses the new dispatch. Three runs per
arm, ordered A B B A A B, at 412 × 915 CSS pixels, DPR 2.625, 4× CPU throttling,
12-second touch drags. Each run used a new browser profile, a 30-second startup
window, unthrottled network and confirmed cross-origin isolation/shared memory.
The machine was an Apple M5 with Chrome 155.0.8059.85. These are desktop proxy
measurements, not phone qualification.

| Median | Bypass | Culling | Interpretation |
| --- | ---: | ---: | --- |
| WebGPU marker draws/rendered frame | 48.0 | 23.3 | About 51% fewer submissions |
| WebGPU main-thread ms/frame | 10.78 | 10.26 | About 5% less; all three arms separate |
| WebGPU fps | 57.6 | 57.5 | Within noise |
| WebGL2 marker draws/rendered frame | 48.0 | 23.3 | About 51% fewer submissions |
| WebGL2 main-thread ms/frame | 10.07 | 9.74 | Within noise; no separated regression |
| WebGL2 fps | 57.6 | 57.5 | Within noise |

Main-thread ms/frame is approximate: it is derived from the profiler summary's
rounded main-thread percentage and fps. Full run rows are retained in research's
`build/night/culling-results.md` and `culling-results.json`; profiles are under
`build/benchmarks/startup-audit/profile-tour-phone-night-cull-*`.

## Correctness

- An independent float32 shader-corner oracle checks 30,000 seeded quads,
  projection matrices, scales and cancellation cases.
- Integration tests cover camera turns, delayed frames, full-screen expansion,
  outline margins, display scale and tracked headsets.
- Nine fixed-clock screenshot states match byte for byte on WebGPU, WebGL2
  and an actual WebGL1 context on this machine: map, three entry moments,
  immersion, three exit moments and map again. Both variants must produce
  repeated identical frames before comparison. CSS animation and live
  performance text are suppressed in both arms. Each qualified visit waits for
  its overview and all previews, rather than treating the older harness's
  warm-visit readiness timeout as a pass.

Browser evidence is in research's `build/night/pixels-culling-*-cold/`.
There is no quality, framebuffer resolution, representation-selection or
public settings change.
