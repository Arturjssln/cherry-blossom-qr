# Cherry Blossom QR

A voxel cherry tree that folds down into a scannable QR code, rendered with
WebGPU.

Based on the original by **[siddique-mauve.vercel.app](https://siddique-mauve.vercel.app/)**.

```bash
npm install
npm run dev
```

Needs WebGPU (Chrome/Edge 113+, Safari 26+, Firefox Nightly with flags).

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `main` (and on demand from the Actions tab).

One manual step the first time: **Settings → Pages → Build and deployment →
Source: GitHub Actions**. Without it the workflow builds fine but the deploy
step fails.

`vite.config.js` sets `base: './'`, so the bundle uses relative asset paths and
works both at `user.github.io/cherry-blossom-qr/` and at a custom-domain root -
no base path to keep in sync with the repo name.

## The core idea

There is exactly **one** scene, and one number drives everything: `progress`.

- `progress = 0` — isometric camera, full 3D tree.
- `progress = 1` — top-down orthographic camera, flat QR code.

Every pass applies the *same* camera transform (yaw lerps `0.78 → 0`, pitch
lerps `-0.55 → -π/2`, scale `1.6 → 2.1`), so all the layers stay locked together
through the animation. Nothing is swapped out or re-uploaded when you toggle —
the vertex shaders just scale geometry to zero:

| Geometry | Visible when |
|---|---|
| Ground layer (the QR code) | always |
| Trunk / canopy voxels above ground | `progress → 0` |
| Branch cylinders, blossoms, grass, falling petals | `progress → 0` |

The ground layer is the QR matrix itself, one voxel per module, with the
material chosen so dark modules read dark from above (`Trunk` near the centre,
`FallenPetals` under the canopy, `Grass` outside it) and light modules read as
`Dirt`. In the fragment shader, `qrBoost = progress²` ramps the dark/light
contrast up as you flatten, so the 3D view stays soft and the 2D view scans.

## The tree comes from the QR code

`deriveTreeParams` measures two things about the matrix — module **density** and
**edge ratio** (how often neighbouring cells differ) — and maps them onto trunk
height, lean, branch count, spread, recursion depth and canopy density. Same
input always grows the same tree; a different input grows a visibly different
one. Any string works - a URL, a note, a haiku - not just links.

`generateBranchSkeleton` then walks that: a leaning 10-segment trunk, a ring of
main lateral branches arcing out from the upper trunk, a crown of upward shoots,
and recursive forks. It returns the segment list *and* the branch **tips**, which
is what makes the blossoms sit on the branches rather than float in a ball.

## Passes

Drawn in this order into a single render pass:

| # | Pass | Vertices | Buffer |
|---|---|---|---|
| 1 | Sky | 3 (fullscreen tri) | — |
| 2 | Ground shadow | 6 | — |
| 3 | Voxels | `36 × blocks` | 4 storage buffers |
| 4 | Grass | `3 × blades` | `grassData` |
| 5 | Branches | `48 × segments` | `branchData` |
| 6 | Blossoms | `150 × flowers` | `flowerPositions` |
| 7 | Falling petals | `150 × petals` | `petalData` |

No vertex or index buffers anywhere — every pass builds its geometry from
`@builtin(vertex_index)` plus a read-only storage buffer. A blossom is 5 petals
× 4 quad-strip segments (120 verts) plus a 10-slice centre disk (30). A branch
segment is an 8-sided tapered cylinder. A grass blade is one triangle.

`uniforms.blockCount` is reused per-pass as "however many instances this pass
has", which is why the branch, grass and falling-petal passes each get their own
32-byte uniform buffer. The blossom pass shares the block one (it never reads
the count).

## Seasons

The `season` uniform (0–3) is read only in the fragment shaders. Nothing is
regenerated when you switch:

- **Spring** — pink blossoms, green grass, petals falling.
- **Summer** — every flower renders as a dense green leaf; nothing falls.
- **Autumn** — warm leaves, 40% `discard`ed so bare branches show through.
- **Winter** — 80% `discard`ed, pale buds, and the falling pass renders as snow.

## Files

```
src/
  constants.js          camera angles, block size, buffer budgets, palette tints
  qr.js                 QR matrix from any string (wraps the `qrcode` package)
  geometry/
    noise.js            hash noise, matches the shaders' formula
    blocks.js           voxel field + blossoms on the canopy cube stacks
    tree.js             QR → tree params → branch skeleton + tips
    canopy.js           blossom clouds around tips, ground petals, falling petals
    grass.js            blades on dark modules outside the canopy
  shaders/
    common.js           shared uniform struct + ACES tonemap
    blocks.js  backdrop.js  flowers.js  branches.js  grass.js  fallingFlowers.js
  useWebGPUScene.js     device setup, buffers, pipelines, frame loop
  App.jsx               UI: text input + validation, seasons, tap-to-flip
  styles.js
```

## Capacity

Input is capped at **2331 UTF-8 bytes** - the byte-mode capacity of a version-40
QR code at error correction level M, which is what `qr.js` encodes with. The
counter is in bytes rather than characters because one emoji costs four, so a
1200-character emoji string is already 2400 bytes and won't fit. `EC_LEVEL` and
`MAX_QR_BYTES` sit next to each other in `qr.js` and have to move together.

Longer input means a physically bigger code - 25 modules across for a short URL,
up to 177 for a full one - so two things scale with `gridSize`:

- **Framing.** `CAMERA_WGSL` in `shaders/common.js` zooms out in proportion, so
  a long message still fits on screen. Every pass calls the same
  `viewScaleFor()`, which is what keeps the layers locked together.
- **Proportions.** The canopy radius is a fraction of the grid but the trunk is
  sized in world units, so `deriveTreeParams` scales trunk height, radius and
  lean to match. Without this a long message grows a wide canopy on a stubby
  trunk.

Both are clamped at `REFERENCE_GRID` (29), the size the look was tuned against:
codes at or below it are untouched, so short input renders exactly as before.

## Notes

- `qr.js` reads modules as `get(col, row)` but stores `rows[row][col]`, so the
  matrix is **transposed**. Most scanners read mirrored codes fine.
- `tree.js` crown branches compute `steps = 2 + Math.floor(hash(...))`, and
  `hash()` is in `[0,1)`, so that always floors to 0 → always 2 steps. Left
  alone deliberately: changing it changes the silhouette.
- The shadow fragment shader returns fully transparent; the pass is wired up but
  visually disabled. There's a one-line note in `backdrop.js` on re-enabling it.
- Branch/grass/falling-petal pipelines are wrapped in try/catch — if one fails to
  compile the scene still renders without that layer.

## Interactions

- Click the canvas or press <kbd>Space</kbd> to flip between tree and QR.
- <kbd>1</kbd>–<kbd>4</kbd> select the season.
- Type anything - a URL, a message, an emoji - then <kbd>Enter</kbd> or → to re-grow the tree.
