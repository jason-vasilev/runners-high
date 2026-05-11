#!/usr/bin/env node
/**
 * download-model.js
 *
 * Fetches a pretrained object-detection ONNX model into ./models/bib-detector.onnx.
 *
 * v1 strategy: there is no single, frictionless URL for a *bib-specific* detector
 * (Roboflow's hosted model requires an API key). So we ship a general-purpose
 * YOLOv8n COCO model that knows the "person" class. The indexer then heuristically
 * crops the runner's torso region (where the bib sits) and OCRs that.
 *
 * To upgrade to a true bib detector later, export your trained model to ONNX and
 * drop it at ./models/bib-detector.onnx (overwriting this file). The indexer
 * auto-detects the input shape and class count.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = path.join(__dirname, '..', 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'bib-detector.onnx');

// Candidate sources, tried in order. All are public, no API key required.
// Verified 2026-05-10. If one breaks, the next is tried automatically.
const CANDIDATES = [
  {
    name: 'YOLOv8n (Kalray mirror on Hugging Face)',
    url: 'https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx',
    license: 'AGPL-3.0 (Ultralytics) — fine for personal / demo use.',
    expectedMinBytes: 10 * 1024 * 1024, // ~12.8 MB
  },
  {
    name: 'YOLOv9-c (Xenova mirror on Hugging Face) — larger but same output format',
    url: 'https://huggingface.co/Xenova/yolov9-c_all/resolve/main/onnx/model.onnx',
    license: 'GPL-3.0.',
    expectedMinBytes: 10 * 1024 * 1024,
  },
];

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'runners-high-setup/0.1' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects <= 0) return reject(new Error('Too many redirects'));
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function download(url, dest) {
  const res = await get(url);
  const total = Number(res.headers['content-length'] || 0);
  let downloaded = 0;
  let lastLogged = 0;
  await new Promise((resolve, reject) => {
    const tmp = dest + '.partial';
    const file = fs.createWriteStream(tmp);
    res.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total && downloaded - lastLogged > 1024 * 1024) {
        const pct = ((downloaded / total) * 100).toFixed(0);
        process.stdout.write(`\r  downloaded ${(downloaded / 1024 / 1024).toFixed(1)} MB (${pct}%)   `);
        lastLogged = downloaded;
      }
    });
    res.pipe(file);
    file.on('finish', () => file.close(() => {
      fs.renameSync(tmp, dest);
      resolve();
    }));
    file.on('error', (err) => {
      try { fs.unlinkSync(tmp); } catch {}
      reject(err);
    });
  });
  process.stdout.write('\n');
}

async function main() {
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  if (fs.existsSync(MODEL_PATH)) {
    const size = (fs.statSync(MODEL_PATH).size / 1024 / 1024).toFixed(1);
    console.log(`Model already present at ${path.relative(process.cwd(), MODEL_PATH)} (${size} MB). Skipping.`);
    console.log('Delete the file and re-run to fetch again.');
    return;
  }

  console.log('Runners\' High — model setup');
  console.log('────────────────────────────');

  let lastErr;
  for (const c of CANDIDATES) {
    try {
      console.log(`\nTrying: ${c.name}`);
      console.log(`  URL:     ${c.url}`);
      console.log(`  License: ${c.license}`);
      await download(c.url, MODEL_PATH);
      const bytes = fs.statSync(MODEL_PATH).size;
      if (c.expectedMinBytes && bytes < c.expectedMinBytes) {
        fs.unlinkSync(MODEL_PATH);
        throw new Error(`Downloaded file too small (${bytes} bytes) — probably an error page, not the model.`);
      }
      const size = (bytes / 1024 / 1024).toFixed(1);
      console.log(`✓ Saved to models/bib-detector.onnx (${size} MB)\n`);
      console.log('Next steps:');
      console.log('  1. Drop event photos into photos/demo-marathon/');
      console.log('  2. Run: npm run index');
      console.log('  3. Run: npm run dev   →   http://localhost:8080');
      return;
    } catch (err) {
      lastErr = err;
      console.log(`  ✗ ${err.message}`);
    }
  }

  console.error('\nNone of the candidate sources worked. Last error:', lastErr?.message);
  console.error('\nManual fallback — any of these works:');
  console.error('  A) Browse to https://huggingface.co/Kalray/yolov8 and click yolov8n.onnx → Download.');
  console.error('  B) Or export your own:  pip install ultralytics  →  yolo export model=yolov8n.pt format=onnx');
  console.error('  C) Or use any YOLOv8 / YOLOv9 ONNX model you trust.');
  console.error('  Then save the file to: models/bib-detector.onnx');
  console.error('\nThe indexer can also run without a model — it falls back to whole-image OCR.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
