#!/usr/bin/env node
/**
 * build-pages.js
 *
 * Assembles the docs/ folder that GitHub Pages serves.
 * Run after `npm run index` so thumbs/ and data/index.json are up to date.
 *
 *   docs/
 *     index.html, app.js, styles.css   ← from public/
 *     404.html                          ← SPA fallback redirect
 *     data/index.json                   ← from data/
 *     thumbs/**                         ← from thumbs/
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

function requirePath(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`✗ Missing ${label} at ${path.relative(ROOT, p)} — run \`npm run index\` first.`);
    process.exit(1);
  }
}

requirePath(path.join(ROOT, 'data', 'index.json'), 'data/index.json');
requirePath(path.join(ROOT, 'thumbs'), 'thumbs/');
requirePath(path.join(ROOT, 'mids'), 'mids/');
requirePath(path.join(ROOT, 'public', 'lib'), 'public/lib/');

// Wipe and recreate docs/
fs.rmSync(DOCS, { recursive: true, force: true });
fs.mkdirSync(DOCS, { recursive: true });

// public/ → docs/
fs.cpSync(path.join(ROOT, 'public'), DOCS, { recursive: true });

// data/ → docs/data/
fs.cpSync(path.join(ROOT, 'data'), path.join(DOCS, 'data'), { recursive: true });

// thumbs/ → docs/thumbs/
fs.cpSync(path.join(ROOT, 'thumbs'), path.join(DOCS, 'thumbs'), { recursive: true });

// mids/ → docs/mids/
fs.cpSync(path.join(ROOT, 'mids'), path.join(DOCS, 'mids'), { recursive: true });

// 404.html — redirect SPA fallback
const notFound = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0;url=/runners-high/" />
    <title>Runner's High</title>
  </head>
  <body>
    <p>Redirecting… <a href="/runners-high/">go home</a></p>
  </body>
</html>
`;
fs.writeFileSync(path.join(DOCS, '404.html'), notFound);

// Report
const thumbCount = fs.readdirSync(path.join(DOCS, 'thumbs'), { recursive: true })
  .filter((f) => f.endsWith('.webp')).length;
const midCount = fs.readdirSync(path.join(DOCS, 'mids'), { recursive: true })
  .filter((f) => f.endsWith('.webp')).length;
const docsSize = du(DOCS);
console.log(`✓ docs/ built — ${thumbCount} thumbs + ${midCount} mids, ~${(docsSize / 1024 / 1024).toFixed(1)} MB total`);

function du(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += du(full);
    else total += fs.statSync(full).size;
  }
  return total;
}
