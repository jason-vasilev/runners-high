# Runner's High

A static web app to help running-event participants find photos of themselves by typing their **bib number** or **name** into a giant search bar.

How it works:

1. **Indexer** (Node.js, run once per event): walks `photos/<event>/`, uses a YOLO ONNX model to find runners, crops the torso region where the bib sits, and OCRs each crop with Tesseract.js for bib numbers + names. Writes everything to `data/index.json`.
2. **Frontend** (plain HTML/JS, no build step): loads the JSON index into MiniSearch for instant fuzzy search across thousands of photos.

Everything is free and open source. No cloud, no API keys.

## Quickstart

```bash
cd runners-high
npm install
npm run setup            # downloads the detector model (~12 MB) into models/
```

Drop event photos into `photos/demo-marathon/` (or any `photos/<event>/` folder), then:

```bash
npm run index            # process new images, update data/index.json
npm run dev              # http://localhost:8080
```

## Useful commands

| Command | What it does |
|---|---|
| `npm run setup` | Download the pretrained detector ONNX model. |
| `npm run index` | Incremental: only re-processes new or modified images. |
| `npm run index -- --force` | Re-index everything from scratch. |
| `npm run index -- --verbose` | Print OCR output per image (helpful for debugging). |
| `npm run index -- --dir photos/london-2026` | Index only one event folder. |
| `npm run dev` | Start the local server on port 8080. |

## Folder structure

```
runners-high/
├── photos/                  # Your photo library (gitignored)
│   └── demo-marathon/       # Each subfolder = one event
├── models/                  # Pretrained ONNX detector (gitignored)
├── data/index.json          # Generated index, consumed by the frontend
├── scripts/                 # Indexer + setup
├── public/                  # The frontend (index.html, app.js, styles.css)
└── server.js                # Tiny local static server
```

## Tech stack

- **[sharp](https://sharp.pixelplumbing.com/)** — fast image preprocessing.
- **[onnxruntime-node](https://onnxruntime.ai/)** — runs the YOLOv8 ONNX detector on the CPU.
- **[tesseract.js](https://tesseract.projectnaptha.com/)** — OCR, two passes per bib crop (digits + letters).
- **[MiniSearch](https://lucaong.github.io/minisearch/)** — ~10 KB client-side fuzzy / prefix search.

No bundler, no framework. The frontend is plain ES modules loading MiniSearch via CDN.

## Detection accuracy

v1 ships with a general-purpose **YOLOv8n** model trained on COCO — it detects *people*, and the indexer heuristically crops the torso region (roughly where bibs sit). This works surprisingly well for most race photos.

For higher accuracy on stylized bibs / unusual lighting, train or download a **bib-specific** detector and drop it in at `models/bib-detector.onnx`. The indexer handles both single-class (bib) and multi-class (COCO) outputs automatically.

Useful starting points for a bib-specific model:

- [ericBayless/bib-detector](https://github.com/ericBayless/bib-detector) (YOLOv4-tiny, RBNR-trained)
- [Roboflow Universe — bib-detector](https://universe.roboflow.com/rbnr/bib-detector) (pre-trained, export to ONNX)
- The [RBNR dataset](https://people.csail.mit.edu/talidekel/RBNR.html) for training your own.

## Known limitations (v1)

- Names on bibs use stylized fonts; OCR misses some. The bib detector + crop preprocessing helps but isn't perfect.
- Indexing is CPU-bound — roughly 1–3 sec per image. A few hundred photos = a few minutes.
- If the detector model can't be downloaded, the indexer falls back to OCRing the middle horizontal band of each photo (still useful but noisier).

## Deploy later

Because the frontend is static and the index is a single JSON file, you can deploy this to any static host:

1. Copy `public/`, `data/index.json`, and your `photos/` folder to the host.
2. Make sure URLs `/photos/...` and `/data/index.json` are reachable.
3. Done — no server runtime needed.
