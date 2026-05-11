#!/usr/bin/env node
/**
 * index-photos.js
 *
 * Walks ./photos/ for image files, detects runners with a YOLO ONNX model,
 * crops the torso region (where bibs sit), and OCRs each crop for bib
 * numbers and names. Writes the result to ./data/index.json.
 *
 * If no model is present at ./models/bib-detector.onnx, falls back to
 * whole-image OCR (less accurate but still useful).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const THUMBS_DIR = path.join(ROOT, 'thumbs');
const DATA_DIR = path.join(ROOT, 'data');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const MODEL_PATH = path.join(ROOT, 'models', 'bib-detector.onnx');
const THUMB_WIDTH = 600; // wide enough for retina grid cards (~300 css px)
const THUMB_QUALITY = 75;

const args = parseArgs(process.argv.slice(2));
const VERBOSE = args.verbose;
const FORCE = args.force;
const ONLY_DIR = args.dir ? path.resolve(args.dir) : null;
const DEBUG_CROPS = args.debugCrops;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DEBUG_DIR = path.join(ROOT, 'debug', 'crops');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--debug-crops') out.debugCrops = true;
  }
  return out;
}

function log(...args) { console.log(...args); }
function vlog(...args) { if (VERBOSE) console.log(...args); }

function walkImages(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkImages(full));
    else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

// ───── YOLOv8 detection ─────────────────────────────────────────────────────
// Loads the ONNX model lazily and exposes detectPersons(imageBuffer, width, height).

let ortSession = null;
let ortInputName = null;
let ortInputSize = 640;
let ortAvailable = null; // tri-state: null=unknown, true/false=known

async function ensureModel() {
  if (ortAvailable !== null) return ortAvailable;
  if (!fs.existsSync(MODEL_PATH)) {
    log('No detector model found at models/bib-detector.onnx — falling back to whole-image OCR.');
    log('Tip: run `npm run setup` to download a default model.');
    ortAvailable = false;
    return false;
  }
  try {
    const ort = await import('onnxruntime-node');
    ortSession = await ort.InferenceSession.create(MODEL_PATH);
    ortInputName = ortSession.inputNames[0];
    // Try to read input shape; default to 640 if dynamic.
    const inputMeta = ortSession.inputMetadata?.[ortInputName] || ortSession.inputNames.length;
    const dims = ortSession.handler?.inputMetadata?.[0]?.dimensions
      || ortSession.inputMetadata?.[ortInputName]?.dimensions;
    if (Array.isArray(dims) && typeof dims[2] === 'number' && dims[2] > 0) {
      ortInputSize = dims[2];
    }
    log(`Loaded detector model (input ${ortInputSize}x${ortInputSize}).`);
    ortAvailable = true;
    return true;
  } catch (err) {
    log(`Failed to load model (${err.message}). Falling back to whole-image OCR.`);
    ortAvailable = false;
    return false;
  }
}

/**
 * Run YOLOv8 on the image. Returns an array of person boxes
 * [{x, y, w, h, confidence}] in original image pixel coordinates.
 * Only class index 0 ("person") is retained for the COCO-pretrained model.
 * For a bib-specific model trained on a single class, we return all class-0 hits.
 */
async function detectPersons(imageBuffer, origW, origH) {
  if (!ortAvailable) return [];
  const ort = await import('onnxruntime-node');
  const S = ortInputSize;

  // Letterbox to SxS keeping aspect ratio.
  const scale = Math.min(S / origW, S / origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);
  const padX = Math.floor((S - newW) / 2);
  const padY = Math.floor((S - newH) / 2);

  const resized = await sharp(imageBuffer)
    .resize(newW, newH)
    .extend({ top: padY, bottom: S - newH - padY, left: padX, right: S - newW - padX, background: { r: 114, g: 114, b: 114 } })
    .removeAlpha()
    .raw()
    .toBuffer(); // HWC, uint8

  // Convert HWC uint8 → CHW float32 normalized [0,1].
  const chw = new Float32Array(3 * S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const src = (y * S + x) * 3;
      const dst = y * S + x;
      chw[dst] = resized[src] / 255;
      chw[S * S + dst] = resized[src + 1] / 255;
      chw[2 * S * S + dst] = resized[src + 2] / 255;
    }
  }

  const tensor = new ort.Tensor('float32', chw, [1, 3, S, S]);
  const results = await ortSession.run({ [ortInputName]: tensor });
  const out = results[ortSession.outputNames[0]];
  // YOLOv8 ONNX output: [1, 84, 8400] for COCO (4 box + 80 classes)
  // For a single-class model: [1, 5, N] (4 box + 1 class)
  const data = out.data;
  const [_, channels, anchors] = out.dims;
  const numClasses = channels - 4;
  const CONF_THRESHOLD = 0.35;

  const candidates = [];
  for (let i = 0; i < anchors; i++) {
    // Find max class score
    let bestCls = 0;
    let bestScore = data[(4) * anchors + i];
    for (let c = 1; c < numClasses; c++) {
      const v = data[(4 + c) * anchors + i];
      if (v > bestScore) { bestScore = v; bestCls = c; }
    }
    if (bestScore < CONF_THRESHOLD) continue;
    // Only keep "person" (class 0) for COCO; for single-class models numClasses==1.
    if (numClasses > 1 && bestCls !== 0) continue;

    const cx = data[0 * anchors + i];
    const cy = data[1 * anchors + i];
    const w  = data[2 * anchors + i];
    const h  = data[3 * anchors + i];

    // Undo letterbox → original image coords
    const x = (cx - w / 2 - padX) / scale;
    const y = (cy - h / 2 - padY) / scale;
    const bw = w / scale;
    const bh = h / scale;
    candidates.push({ x, y, w: bw, h: bh, confidence: bestScore });
  }

  return nms(candidates, 0.5);
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = a.w * a.h + b.w * b.h - inter;
  return ua > 0 ? inter / ua : 0;
}

function nms(boxes, threshold) {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const keep = [];
  while (sorted.length) {
    const top = sorted.shift();
    keep.push(top);
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(top, sorted[i]) > threshold) sorted.splice(i, 1);
    }
  }
  return keep;
}

// ───── OCR ──────────────────────────────────────────────────────────────────

let ocrWorker = null;

async function ensureWorkers() {
  if (ocrWorker) return;
  ocrWorker = await Tesseract.createWorker('eng');
  await ocrWorker.setParameters({
    // PSM 11 = "sparse text" — find text wherever it appears in the crop.
    // PSM 7 / PSM 6 require text to be neatly laid out, which fails on
    // marathon photos where the bib is one small region among clothing,
    // sponsor logos, and background.
    tessedit_pageseg_mode: '11',
  });
}

async function terminateWorkers() {
  if (ocrWorker) await ocrWorker.terminate();
}

function clampBox(b, imgW, imgH) {
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const w = Math.min(imgW - x, Math.floor(b.w));
  const h = Math.min(imgH - y, Math.floor(b.h));
  return { x, y, w, h };
}

function expandBox(b, padFrac, imgW, imgH) {
  const px = b.w * padFrac;
  const py = b.h * padFrac;
  return clampBox({ x: b.x - px, y: b.y - py, w: b.w + 2 * px, h: b.h + 2 * py }, imgW, imgH);
}

let cropCounter = 0;

function extractBibsFromText(text) {
  // Pull all digit runs that look like bib numbers (3-6 digits) and
  // all word-like tokens that look like names.
  const numbers = (text.match(/\d{3,6}/g) || []);
  const names = (text.match(/[A-Za-z][A-Za-z'-]{2,}/g) || [])
    .filter((t) => t.length >= 3)
    .filter((t) => !/^[AEIOU]+$/i.test(t)); // drop pure-vowel noise like "AAA"
  return { numbers, names };
}

async function preprocess(extractedBuffer) {
  // Two common bib styles: black-on-white (most events) and white-on-color.
  // Normalize + sharpen is a safe baseline that helps both.
  return sharp(extractedBuffer).grayscale().normalize().sharpen().png().toBuffer();
}

async function ocrRegion(imageBuffer, box, imgW, imgH, debugName) {
  const region = clampBox(box, imgW, imgH);
  if (region.w < 100 || region.h < 100) {
    vlog(`    skip tiny crop ${region.w}×${region.h}`);
    return { numbers: [], names: [], bbox: region, raw: '' };
  }

  // KEY CHANGE: do NOT shrink the crop. At original resolution a marathon
  // bib is typically 150-250 px tall — fine for Tesseract. If we resize the
  // whole person down to fit a thumbnail, the bib becomes 20-30 px wide
  // and unreadable. Cap at a sensible max for speed.
  const MAX_H = 1800;
  const shouldResize = region.h > MAX_H;

  let pipeline = sharp(imageBuffer).extract({
    left: region.x, top: region.y, width: region.w, height: region.h,
  });
  if (shouldResize) pipeline = pipeline.resize({ height: MAX_H });
  const cropRaw = await pipeline.png().toBuffer();
  const crop = await preprocess(cropRaw);

  if (DEBUG_CROPS) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const fname = `${debugName || 'crop'}-${String(++cropCounter).padStart(4, '0')}.png`;
    fs.writeFileSync(path.join(DEBUG_DIR, fname), crop);
  }

  const result = await ocrWorker.recognize(crop);
  const text = (result.data.text || '').trim();
  const { numbers, names } = extractBibsFromText(text);

  vlog(`    crop ${region.w}×${region.h} → "${text.replace(/\s+/g, ' ').slice(0, 100)}"`);
  return { numbers, names, bbox: region, raw: text };
}

async function ocrWholeImage(imageBuffer, imgW, imgH, debugName) {
  // Downscale only if very large, so OCR is fast but bibs stay legible.
  const MAX_DIM = 2400;
  const scale = Math.min(1, MAX_DIM / Math.max(imgW, imgH));
  const newW = Math.round(imgW * scale);
  const newH = Math.round(imgH * scale);

  const buffer = await sharp(imageBuffer)
    .resize(newW, newH)
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();

  if (DEBUG_CROPS) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${debugName || 'crop'}-whole.png`), buffer);
  }

  const result = await ocrWorker.recognize(buffer);
  const text = (result.data.text || '').trim();
  const { numbers, names } = extractBibsFromText(text);
  vlog(`  whole-image ${newW}×${newH} → "${text.replace(/\s+/g, ' ').slice(0, 120)}"`);
  return { numbers, names };
}

// ───── Index management ────────────────────────────────────────────────────

function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) return { generatedAt: null, images: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return { generatedAt: null, images: [] };
  }
}

function saveIndex(index) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  index.generatedAt = new Date().toISOString();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function relImagePath(absPath) {
  return path.relative(PHOTOS_DIR, absPath).split(path.sep).join('/');
}

function thumbAbsPath(rel) {
  // Replace extension with .webp; keep folder structure mirroring photos/.
  const webp = rel.replace(/\.[^./]+$/, '.webp');
  return path.join(THUMBS_DIR, webp);
}

/**
 * Generate a small WebP thumbnail for the image if one is missing or stale.
 * Returns true if a new thumbnail was written, false if skipped.
 */
async function ensureThumbnail(absPath, rel, srcMtime) {
  const thumb = thumbAbsPath(rel);
  if (fs.existsSync(thumb)) {
    const thumbMtime = fs.statSync(thumb).mtimeMs;
    if (thumbMtime >= srcMtime) return false; // up to date
  }
  fs.mkdirSync(path.dirname(thumb), { recursive: true });
  await sharp(absPath)
    .rotate() // honour EXIF orientation so portrait photos aren't sideways
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toFile(thumb);
  return true;
}

// ───── Main ────────────────────────────────────────────────────────────────

async function processImage(absPath) {
  const rel = relImagePath(absPath);
  const buffer = fs.readFileSync(absPath);
  const meta = await sharp(buffer).metadata();
  const imgW = meta.width;
  const imgH = meta.height;
  const imgArea = imgW * imgH;
  const debugName = path.basename(rel, path.extname(rel));

  // Strategy: combine two OCR passes and dedupe.
  //   1) Whole-image OCR catches bibs anywhere, even on runners the detector missed.
  //   2) Person-crop OCR at near-original resolution catches bibs that
  //      would be lost in the downscaled whole-image pass.

  const allNumbers = new Set();
  const allNames = new Set();
  const bbox = (res) => [res.bbox.x, res.bbox.y, res.bbox.w, res.bbox.h];
  const bibs = [];

  // Pass 1: whole image
  const whole = await ocrWholeImage(buffer, imgW, imgH, debugName);
  whole.numbers.forEach((n) => allNumbers.add(n));
  whole.names.forEach((n) => allNames.add(n.toUpperCase()));

  // Pass 2: person crops
  if (await ensureModel()) {
    const people = await detectPersons(buffer, imgW, imgH);
    const filtered = people.filter((p) => {
      const area = p.w * p.h;
      if (area > 0.7 * imgArea) return false; // hallucinated full-frame person
      if (p.h < 200 || p.w < 100) return false; // too small to read a bib
      return true;
    });
    filtered.sort((a, b) => b.confidence - a.confidence);
    const persons = filtered.slice(0, 8); // top-8 by confidence
    vlog(`  ${people.length} detected, ${persons.length} kept after filtering.`);

    for (const p of persons) {
      const region = expandBox(p, 0.05, imgW, imgH);
      const res = await ocrRegion(buffer, region, imgW, imgH, debugName);
      const cropNumbers = new Set(res.numbers);
      const cropNames = new Set(res.names.map((n) => n.toUpperCase()));
      res.numbers.forEach((n) => allNumbers.add(n));
      res.names.forEach((n) => allNames.add(n.toUpperCase()));

      // If this crop yielded a specific bib, attach it to its bbox so the
      // frontend can later draw / link to a per-runner result.
      if (cropNumbers.size || cropNames.size) {
        bibs.push({
          number: [...cropNumbers][0] || null,
          name: [...cropNames].slice(0, 3).join(' ') || null,
          bbox: bbox(res),
        });
      }
    }
  }

  // Whole-image extras (text not tied to any crop): add as bibs without bbox
  // so they're still searchable.
  const usedNumbers = new Set(bibs.map((b) => b.number).filter(Boolean));
  for (const n of allNumbers) {
    if (!usedNumbers.has(n)) bibs.push({ number: n, name: null, bbox: null });
  }
  if (bibs.length === 0 && allNames.size > 0) {
    bibs.push({ number: null, name: [...allNames].slice(0, 3).join(' '), bbox: null });
  }

  return {
    image: rel,
    bibs,
    indexedAt: new Date().toISOString(),
    mtime: fs.statSync(absPath).mtimeMs,
  };
}

async function main() {
  const baseDir = ONLY_DIR || PHOTOS_DIR;
  const files = walkImages(baseDir);
  if (files.length === 0) {
    log(`No images found in ${path.relative(ROOT, baseDir)}/`);
    log('Drop .jpg / .png files into photos/<event-name>/ and re-run.');
    return;
  }

  const index = loadIndex();
  const existing = new Map(index.images.map((r) => [r.image, r]));
  // Track which relative paths were found in this walk so we can prune stale entries.
  const foundRels = new Set(files.map((f) => relImagePath(f)));

  await ensureWorkers();
  log(`Indexing ${files.length} image(s)…`);

  let processed = 0;
  let skipped = 0;
  let thumbsBuilt = 0;
  for (const file of files) {
    const rel = relImagePath(file);
    const prior = existing.get(rel);
    const mtime = fs.statSync(file).mtimeMs;

    // Always make sure a thumbnail exists (cheap, idempotent). Decoupled
    // from OCR so re-running after a code change rebuilds missing thumbs
    // without re-OCRing every image.
    try {
      if (await ensureThumbnail(file, rel, mtime)) thumbsBuilt++;
    } catch (err) {
      log(`   ✗ thumbnail failed for ${rel}: ${err.message}`);
    }

    if (!FORCE && prior && prior.mtime === mtime) {
      vlog(`· skip  ${rel} (unchanged)`);
      skipped++;
      continue;
    }

    log(`→ ${rel}`);
    try {
      const record = await processImage(file);
      existing.set(rel, record);
      processed++;
      const summary = record.bibs.length
        ? record.bibs.map((b) => `#${b.number || '?'} ${b.name || ''}`.trim()).join(', ')
        : '(no bibs)';
      log(`   ${summary}`);
    } catch (err) {
      log(`   ✗ ${err.message}`);
    }

    if (processed > 0 && processed % 10 === 0) {
      // Persist progress periodically so a crash doesn't lose all work.
      index.images = [...existing.values()].filter((r) => foundRels.has(r.image));
      saveIndex(index);
    }
  }

  // Only keep entries for images that still exist on disk.
  const pruned = index.images.filter((r) => !foundRels.has(r.image)).length;
  index.images = [...existing.values()].filter((r) => foundRels.has(r.image));
  saveIndex(index);
  const pruneNote = pruned ? `, ${pruned} stale entr${pruned === 1 ? 'y' : 'ies'} removed` : '';
  log(`\nDone. ${processed} processed, ${skipped} skipped, ${thumbsBuilt} thumbnail${thumbsBuilt === 1 ? '' : 's'} built${pruneNote}. Index → ${path.relative(ROOT, INDEX_PATH)}`);
  await terminateWorkers();
}

main().catch(async (err) => {
  console.error(err);
  await terminateWorkers().catch(() => {});
  process.exit(1);
});
