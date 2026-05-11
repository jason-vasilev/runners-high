import MiniSearch from "https://cdn.jsdelivr.net/npm/minisearch@7.1.0/+esm";

const $ = (sel) => document.querySelector(sel);
const status = $("#status");
const resultsEl = $("#results");
const searchEl = $("#search");
const lightbox = $("#lightbox");
const lightboxImg = $("#lightbox-img");
const lightboxCap = $("#lightbox-caption");
const lightboxPrev = $("#lightbox-prev");
const lightboxNext = $("#lightbox-next");
const lightboxDownload = $("#lightbox-download");

// Build URLs: thumbnails for the grid and lightbox (originals not shipped with the demo).
const thumbUrl = (image) =>
  `thumbs/${encodeURI(image.replace(/\.[^./]+$/, ".webp"))}`;
const fullUrl = (image) =>
  `thumbs/${encodeURI(image.replace(/\.[^./]+$/, ".webp"))}`;
const fileNameFromPath = (image) => image.split("/").pop();

let mini = null;
let docs = [];
// Currently-rendered, deduped result items — backs the lightbox prev/next nav.
let currentResults = [];
let currentIndex = -1;

function setStatus(text) {
  status.textContent = text;
}

function flatten(index) {
  const docs = [];
  let id = 0;
  for (const img of index.images || []) {
    if (!img.bibs || img.bibs.length === 0) {
      // Still searchable by filename so the user can browse.
      docs.push({
        id: ++id,
        image: img.image,
        number: "",
        name: "",
        filename: img.image,
      });
      continue;
    }
    for (const bib of img.bibs) {
      docs.push({
        id: ++id,
        image: img.image,
        number: bib.number || "",
        name: bib.name || "",
        filename: img.image,
      });
    }
  }
  return docs;
}

function renderResults(items) {
  resultsEl.innerHTML = "";
  currentResults = [];
  if (!items.length) {
    resultsEl.innerHTML =
      '<div class="empty">No matching photos. Try a different bib number or name.</div>';
    return;
  }
  const seenImages = new Set();
  for (const item of items) {
    if (seenImages.has(item.image)) continue;
    seenImages.add(item.image);
    currentResults.push(item);
  }
  const frag = document.createDocumentFragment();
  currentResults.forEach((item, idx) => {
    const card = document.createElement("button");
    card.className = "card";
    card.type = "button";
    card.innerHTML = `
      <img loading="lazy" src="${thumbUrl(item.image)}" alt="" />
      <div class="meta">
        ${item.number ? `<span class="num">#${escapeHtml(item.number)}</span>` : ""}
        ${item.name ? `<span class="name">${escapeHtml(item.name)}</span>` : ""}
      </div>
    `;
    card.addEventListener("click", () => openLightbox(idx));
    frag.appendChild(card);
  });
  resultsEl.appendChild(frag);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function showLightboxItem(index) {
  if (!currentResults.length) return;
  // Wrap around at both ends so navigation never dead-ends.
  const len = currentResults.length;
  currentIndex = ((index % len) + len) % len;
  const item = currentResults[currentIndex];
  const full = fullUrl(item.image);
  lightboxImg.src = full;
  lightboxImg.alt = item.name || item.number || item.image;
  const parts = [
    item.number && `#${item.number}`,
    item.name,
    `${currentIndex + 1} / ${len}`,
  ].filter(Boolean);
  lightboxCap.textContent = parts.join(" • ");
  // Update the Download link to point at the same full-resolution file.
  lightboxDownload.href = full;
  lightboxDownload.setAttribute("download", fileNameFromPath(item.image));
  // Prefetch neighbours so arrow-key navigation feels instant.
  preloadNeighbor(currentIndex + 1);
  preloadNeighbor(currentIndex - 1);
  // Hide the nav buttons when there's nothing to navigate to.
  const single = len <= 1;
  lightboxPrev.hidden = single;
  lightboxNext.hidden = single;
}

function preloadNeighbor(i) {
  if (!currentResults.length) return;
  const len = currentResults.length;
  const wrapped = ((i % len) + len) % len;
  const img = new Image();
  img.src = fullUrl(currentResults[wrapped].image);
}

function openLightbox(index) {
  showLightboxItem(index);
  lightbox.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxImg.src = "";
  currentIndex = -1;
  document.body.style.overflow = "";
}

function navigateLightbox(delta) {
  if (currentIndex < 0) return;
  showLightboxItem(currentIndex + delta);
}

lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox || e.target.classList.contains("lightbox-close"))
    closeLightbox();
});
lightboxPrev.addEventListener("click", (e) => {
  e.stopPropagation();
  navigateLightbox(-1);
});
lightboxNext.addEventListener("click", (e) => {
  e.stopPropagation();
  navigateLightbox(1);
});
lightboxDownload.addEventListener("click", (e) => {
  e.stopPropagation(); /* let the browser handle the actual download */
});

window.addEventListener("keydown", (e) => {
  if (lightbox.hidden) return;
  if (e.key === "Escape") {
    closeLightbox();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    navigateLightbox(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    navigateLightbox(1);
  }
});

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function uniqueImageCount(items) {
  const s = new Set();
  for (const it of items) s.add(it.image);
  return s.size;
}

function runSearch(query) {
  query = (query || "").trim();
  if (!query) {
    // Empty query → show everything. renderResults dedupes by image, and
    // <img loading="lazy"> keeps offscreen photos from actually fetching
    // until the user scrolls near them.
    renderResults(docs);
    const total = uniqueImageCount(docs);
    setStatus(
      total
        ? `${total} available. Type to search, or scroll to browse.`
        : "Index is empty.",
    );
    return;
  }
  const isNumeric = /^\d+$/.test(query);
  const results = mini.search(query, {
    prefix: true,
    fuzzy: isNumeric ? 0 : 0.2,
    boost: { number: 3, name: 2 },
  });
  renderResults(results);
  const matches = uniqueImageCount(results);
  setStatus(
    `${matches} photo${matches === 1 ? "" : "s"} match${matches === 1 ? "es" : ""} "${query}"`,
  );
}

async function init() {
  setStatus("Loading index…");
  let index;
  try {
    const res = await fetch("data/index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    index = await res.json();
  } catch (err) {
    setStatus(
      `Could not load index: ${err.message}. Run \`npm run index\` first.`,
    );
    return;
  }

  docs = flatten(index);
  mini = new MiniSearch({
    fields: ["number", "name"],
    storeFields: ["image", "number", "name", "filename"],
    searchOptions: { prefix: true, fuzzy: 0.2 },
    tokenize: (text) =>
      String(text)
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean),
  });
  mini.addAll(docs);

  runSearch("");
  searchEl.addEventListener(
    "input",
    debounce((e) => runSearch(e.target.value), 80),
  );
}

init();
