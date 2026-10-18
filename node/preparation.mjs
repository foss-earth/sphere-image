#!/usr/bin/env node
/**
 * Prepares one sphere for a `foss-earth-scene` v1 manifest: validates the
 * input, its pose and colour; applies EXIF orientation once and converts to
 * opaque sRGB; and writes preview cubes, whole immersion variants and tiled
 * cubes from the one normalized image, with a manifest fragment and a
 * provenance record.
 *
 *   node scripts/prepare-panorama.mjs --input garden.jpg --pose garden-pose.json \
 *     --preview-face-sizes 64,128,256 --immersion-widths 2048,4096 --tiles eac,cube \
 *     --out build/prepared-scenes/garden
 *
 * Input: a full 2:1 equirectangular JPEG or PNG, or `synthetic:cardinal[:width]`
 * for the reference renderer's N/E/S/W text sphere.
 * Pose: `--pose file.json` holding {headingDeg, pitchDeg, rollDeg, provenance},
 * or a GPano pose in the input's XMP. Without either the tool stops: the
 * viewer never invents a survey-aligned north.
 *
 * Options:
 *   --preview-face-sizes 64,128   preview cube face sizes, px (at least one)
 *   --immersion-widths 2048,4096  whole equirectangular immersion widths, px (none: preview-only)
 *   --tiles eac,cube              tiled cubes for looking around (docs/scenes/format.md, "Tiled cubes"):
 *                                 equi-angular (eac) and ordinary (cube); none by default
 *   --tile-size 192               a tile's texels a side; a stored tile adds a gutter texel on every side
 *   --tile-face-size 1536         the finest face, texels: the tile size times a power of two. Default the
 *                                 largest that is at most the input width / 4, its density at the horizon
 *   --encoding jpeg|png           output files (jpeg)
 *   --quality 90                  JPEG quality, 1–100
 *   --asset-id id                 the asset's id (from the input's name)
 *   --attribution "text"          credit shown while the image is visible (required)
 *   --license id --credit-url url optional licence and link
 *   --url-prefix media/garden/    prefix for the fragment's relative URLs
 *   --out dir                     output folder; default a new dated build/prepared-scenes/ folder
 *   --replace                     allow writing into an existing non-empty folder
 *   --native-tier typescript|typescript-worker|single|auto|threaded  projection backend (typescript)
 *   --projection-module path      native-projections/index.js for opt-in single-worker WASM
 *
 * Nothing is fetched from the network.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOrientation, colourIsSrgb, decodeJpeg, decodePng, dropOpaqueAlpha, encodeJpeg, encodePng, readGPano, resizeArea, sniffImage, toLinearImage, toSrgbImage } from "@foss-earth/images/node";
import { CUBE_FACE_NAMES } from "@foss-earth/sphere-cubemap/core";
import { renderCubeFace } from "@foss-earth/sphere-cubemap/preparation";
import { cubePreparationPlan, equirectPyramid, makeCardinalSphere, validatePreparationCoverage } from "@foss-earth/sphere-equirectangular/preparation";
import { renderCubeTile } from "@foss-earth/sphere-tiled-cubemap/preparation";

/**
 * Part of every asset's revision. Raise it with any change that makes this
 * tool write other bytes for the same input and settings (the encoder, the
 * resampling, a file's name): loaders keep files under the revision between
 * visits and never ask for them again (docs/scenes/format.md, "Saved images").
 */
const TOOL_VERSION = "2";
/** A stored tile's texels past its edge, on every side: one bilinear tap never reads another tile. */
const TILE_GUTTER = 1;
const TILE_WARPS = { eac: "equi-angular", cube: "gnomonic" };

const scriptPath = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    if (name === "replace" || name === "help") { options[name] = true; continue; }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    options[name] = value;
  }
  return options;
}

const sizes = (text, name) => (text ?? "").split(",").filter(Boolean).map(value => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`--${name}: ${value} is not a positive whole number of pixels`);
  return number;
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function datedOutput(ownerDirectory) {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const parent = path.join(ownerDirectory, "build", "prepared-scenes");
  mkdirSync(parent, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const directory = path.join(parent, attempt === 1 ? stamp : `${stamp}-${attempt}`);
    if (!existsSync(directory)) { mkdirSync(directory); return directory; }
  }
}

/** Reads and normalizes the input once: orientation applied, colour checked, alpha refused. */
function readInput(input) {
  if (input.startsWith("synthetic:")) {
    const [, kind, width] = input.split(":");
    if (kind !== "cardinal") throw new Error(`unknown synthetic input ${kind}; the only one is synthetic:cardinal`);
    const image = makeCardinalSphere(width ? Number(width) : 2048);
    return {
      image,
      source: { kind: "synthetic", name: "cardinal", description: "The reference renderer's N/E/S/W text panorama with a 30° grid and polar details", width: image.width, height: image.height },
      gpano: null,
    };
  }
  const bytes = readFileSync(input);
  const mimeType = sniffImage(bytes);
  if (!mimeType) throw new Error(`${input}: not a JPEG or PNG by its signature`);
  const decoded = mimeType === "image/png" ? decodePng(bytes) : decodeJpeg(bytes);
  const colour = colourIsSrgb(decoded.colour);
  if (!colour.ok) throw new Error(`${input}: ${colour.reason}. Convert it to sRGB first; this tool does not convert profiles.`);
  const oriented = applyOrientation(decoded, decoded.orientation);
  const image = dropOpaqueAlpha(oriented);
  return {
    image,
    source: {
      kind: "file", name: path.basename(input), sha256: sha256(bytes), bytes: bytes.length, mimeType,
      storedWidth: decoded.width, storedHeight: decoded.height, width: image.width, height: image.height,
      exifOrientation: decoded.orientation, colour: colour.reason,
    },
    gpano: readGPano(decoded.xmp),
  };
}

function readPose(options, gpano) {
  if (options.pose) {
    const pose = JSON.parse(readFileSync(options.pose, "utf8"));
    for (const field of ["headingDeg", "pitchDeg", "rollDeg"]) {
      if (typeof pose[field] !== "number" || !Number.isFinite(pose[field])) throw new Error(`${options.pose}: ${field} must be a number`);
    }
    if (typeof pose.provenance !== "string" || !pose.provenance.trim()) throw new Error(`${options.pose}: say where the pose came from in "provenance", such as "aligned by eye to the street grid"`);
    return { headingDeg: ((pose.headingDeg % 360) + 360) % 360, pitchDeg: pose.pitchDeg, rollDeg: pose.rollDeg, provenance: pose.provenance };
  }
  if (gpano && typeof gpano.PoseHeadingDegrees === "number") {
    return {
      headingDeg: ((gpano.PoseHeadingDegrees % 360) + 360) % 360,
      pitchDeg: typeof gpano.PosePitchDegrees === "number" ? gpano.PosePitchDegrees : 0,
      rollDeg: typeof gpano.PoseRollDegrees === "number" ? gpano.PoseRollDegrees : 0,
      provenance: "GPano XMP in the input",
    };
  }
  throw new Error("no pose: pass --pose with headingDeg, pitchDeg, rollDeg and provenance. The input has no GPano pose, and the viewer never invents one.");
}

export function prepareSphere(argv, ports = {}) {
  const options = parseArgs(argv);
  if (options.help || !options.input) {
    const help = readFileSync(scriptPath, "utf8").split("*/")[0];
    (ports.log ?? console.log)(help); return { exitCode: options.help ? 0 : 1, help };
  }
  if (["single", "typescript-worker", "threaded"].includes(options["native-tier"]) && !ports.projectionReport) throw new Error("Use prepareSphereAsync or the CLI for worker projection tiers");
  const previewSizes = sizes(options["preview-face-sizes"], "preview-face-sizes");
  if (previewSizes.length === 0) throw new Error("--preview-face-sizes needs at least one size: every panorama needs a preview cube");
  const immersionWidths = sizes(options["immersion-widths"], "immersion-widths");
  for (const width of immersionWidths) if (width % 2) throw new Error(`--immersion-widths: ${width} is odd; the height is half the width`);
  const encoding = options.encoding ?? "jpeg";
  if (encoding !== "jpeg" && encoding !== "png") throw new Error("--encoding is jpeg or png");
  const quality = Number(options.quality ?? 90);
  if (!(quality >= 1 && quality <= 100)) throw new Error("--quality is 1 to 100");
  if (!options.attribution) throw new Error("--attribution is required: the credit shown while the image is visible");
  const tileKinds = (options.tiles ?? "").split(",").filter(Boolean);
  for (const kind of tileKinds) if (!TILE_WARPS[kind]) throw new Error(`--tiles: ${kind} is not eac or cube`);
  const tileSize = Number(options["tile-size"] ?? 192);
  if (!Number.isInteger(tileSize) || tileSize < 8) throw new Error("--tile-size is a whole number of texels, 8 or more");

  const { image, source, gpano } = readInput(options.input);
  validatePreparationCoverage(image, gpano);
  const pose = readPose(options, gpano);
  for (const width of immersionWidths) {
    if (width > image.width) throw new Error(`--immersion-widths: ${width} is wider than the ${image.width}-pixel input; preparation does not invent detail`);
  }
  for (const size of previewSizes) {
    if (size > image.width / 4) throw new Error(`--preview-face-sizes: ${size} is larger than the ${image.width / 4} texels a face of this input holds`);
  }
  // The finest tiled face: at most the input's own density at the horizon, a quarter of its width.
  let tileFaceSize = options["tile-face-size"] === undefined ? tileSize : Number(options["tile-face-size"]);
  if (options["tile-face-size"] === undefined) while (tileFaceSize * 2 <= image.width / 4) tileFaceSize *= 2;
  if (tileKinds.length) {
    if (!Number.isInteger(Math.log2(tileFaceSize / tileSize))) throw new Error(`--tile-face-size: ${tileFaceSize} is not ${tileSize} times a power of two`);
    if (tileFaceSize > image.width / 4) throw new Error(`--tile-face-size: ${tileFaceSize} is larger than the ${image.width / 4} texels a face of this input holds`);
  }

  const out = options.out ? path.resolve(options.out) : datedOutput(ports.ownerDirectory ?? process.cwd());
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length > 0 && !options.replace) throw new Error(`${out} is not empty; pass --replace to write into it`);

  const assetId = options["asset-id"] ?? path.basename(options.input.replace(/^synthetic:/, "")).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  const prefix = options["url-prefix"] ?? "";
  const extension = encoding === "jpeg" ? "jpg" : "png";
  const mimeType = encoding === "jpeg" ? "image/jpeg" : "image/png";
  const encode = srgb => (encoding === "jpeg" ? encodeJpeg(srgb, quality) : encodePng(srgb));
  const outputs = [];
  const write = (relative, bytes, width, height) => {
    const file = path.join(out, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    outputs.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes), width, height });
    return bytes.length;
  };

  const linear = toLinearImage(image);
  const pyramid = equirectPyramid(linear);
  const representations = [];
  for (const size of previewSizes) {
    const faces = {};
    let encodedBytes = 0;
    for (const face of CUBE_FACE_NAMES) {
      const relative = `preview-${size}/${face}.${extension}`;
      encodedBytes += write(relative, encode(toSrgbImage(renderCubeFace(cubePreparationPlan(pyramid, size), face, size, ports.projectionKernel))), size, size);
      faces[face] = `${prefix}${relative}`;
    }
    representations.push({ id: `preview-${size}`, role: "preview", projection: "cube", faceSize: size, mimeType, encodedBytes, faces });
  }
  for (const width of immersionWidths) {
    const relative = `immersion-${width}.${extension}`;
    const resized = width === linear.width ? linear : resizeArea(linear, width, width / 2);
    const encodedBytes = write(relative, encode(toSrgbImage(resized)), width, width / 2);
    representations.push({ id: `whole-${width}`, role: "immersion", projection: "equirectangular", width, height: width / 2, mimeType, encodedBytes, url: `${prefix}${relative}` });
  }
  // Tiled cubes: every level resampled from the source, each face with its gutter, cut into tiles.
  const tileSets = [];
  for (const kind of tileKinds) {
    const warp = TILE_WARPS[kind];
    const folder = `${kind}-tiles`;
    const levelBytes = [];
    const files = [];
    for (let level = 0, size = tileSize; size <= tileFaceSize; level++, size *= 2) {
      let bytesOfLevel = 0;
      CUBE_FACE_NAMES.forEach(face => {
        for (let y = 0; y < size / tileSize; y++) for (let x = 0; x < size / tileSize; x++) {
          const relative = `${folder}/${face}/${level}/${x}/${y}.${extension}`;
          const bytes = encode(toSrgbImage(renderCubeTile(cubePreparationPlan(pyramid, size), face, size, warp, TILE_GUTTER, tileSize, x, y, ports.projectionKernel)));
          const file = path.join(out, relative);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, bytes);
          files.push(`${relative} ${sha256(bytes)}`);
          bytesOfLevel += bytes.length;
        }
      });
      levelBytes.push(bytesOfLevel);
    }
    const encodedBytes = levelBytes.reduce((sum, bytes) => sum + bytes, 0);
    representations.push({ id: folder, role: "immersion", projection: "tiled-cube", warp, faceSize: tileFaceSize, tileSize, gutter: TILE_GUTTER, levelBytes, mimeType, encodedBytes, url: `${prefix}${folder}/` });
    // One provenance entry for the set: its files' paths and hashes, hashed in order.
    tileSets.push({ path: `${folder}/`, files: files.length, bytes: encodedBytes, sha256: sha256(Buffer.from(files.join("\n"))), faceSize: tileFaceSize, tileSize, gutter: TILE_GUTTER, warp });
  }

  const identity = source.sha256 ?? sha256(Buffer.from(JSON.stringify(source)));
  const settings = {
    previewSizes, immersionWidths, encoding, quality, pose: { headingDeg: pose.headingDeg, pitchDeg: pose.pitchDeg, rollDeg: pose.rollDeg },
    ...(tileKinds.length ? { tiles: { kinds: tileKinds, tileSize, faceSize: tileFaceSize, gutter: TILE_GUTTER } } : {}),
  };
  const revision = options.revision ?? sha256(Buffer.from(`${identity}\n${TOOL_VERSION}\n${JSON.stringify(settings)}`)).slice(0, 12);
  const attribution = {
    text: options.attribution,
    ...(options.license ? { license: options.license } : {}),
    ...(options["credit-url"] ? { url: options["credit-url"] } : {}),
  };
  const fragment = {
    asset: { id: assetId, revision, type: "panorama-image", colorSpace: "srgb", alpha: "opaque", attribution, representations },
    imagePose: { headingDeg: pose.headingDeg, pitchDeg: pose.pitchDeg, rollDeg: pose.rollDeg },
  };
  writeFileSync(path.join(out, "asset.fragment.json"), `${JSON.stringify(fragment, null, 2)}\n`);
  const provenance = {
    tool: "scripts/prepare-panorama.mjs",
    toolVersion: TOOL_VERSION,
    scriptSha256: sha256(readFileSync(scriptPath)),
    components: Object.fromEntries(["@foss-earth/images/node", "@foss-earth/sphere-cubemap/preparation", "@foss-earth/sphere-equirectangular/preparation", "@foss-earth/sphere-tiled-cubemap/preparation"].map(entry => [entry, { entrySha256: sha256(readFileSync(fileURLToPath(import.meta.resolve(entry)))) }])),
    sourceRevision: "90e23b3ee96f53ec5900afc5991a21fffa58649d",
    compatibility: "toolVersion 2 resamples without reading past the source's last row or column, where toolVersion 1 left some images' last row black; otherwise as toolVersion 1, which retains original intended image bytes, paths and revision inputs; exact split-artifact byte comparison pending; component entry digests replace monolithic libSha256",
    node: process.version,
    source,
    gpano,
    pose,
    settings,
    processing: "EXIF orientation applied once; colour checked as sRGB and not converted; opaque alpha dropped; resampled in linear light and encoded to sRGB once. Faces follow the format's cube table; tiled faces carry a gutter resampled past their edges.",
    outputs,
    nativeCores: [ports.projectionReport?.() ?? { core: "projections", requested: options["native-tier"] ?? "typescript", actual: "typescript", placement: "original", state: "ready", parity: "not-run", scope: "cube faces and tiled/gutter equirectangular reprojection" }],
    ...(tileSets.length ? { tiles: tileSets } : {}),
  };
  writeFileSync(path.join(out, "prepared.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  const tileFiles = tileSets.reduce((sum, set) => sum + set.files, 0), tileBytes = tileSets.reduce((sum, set) => sum + set.bytes, 0);
  (ports.log ?? console.log)(`Prepared ${assetId} (${image.width}×${image.height}) into ${path.relative(process.cwd(), out) || "."}: ${outputs.length + tileFiles} files, ${outputs.reduce((sum, entry) => sum + entry.bytes, 0) + tileBytes} bytes.`);
  return { exitCode: 0, out, fragment, provenance };
}

export { prepareSphereAsync } from "./projection-preparation.mjs";
