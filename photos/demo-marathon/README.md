# Demo marathon photos

Drop your event photos into this folder (JPEG or PNG). Subfolders are fine — the indexer recurses.

Then from the project root run:

```bash
npm run index
```

You can also create sibling folders for other events (e.g. `photos/london-2026/`) and re-run the indexer; everything ends up in the same searchable library.

Photos here are **gitignored** by default — they live only on your machine.
