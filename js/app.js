/* ==========================================================================
 * m4ster-sprite-gen — free, open-source, unlimited 2D sprite generator.
 * Runs 100% client-side. The only network call is the AI image source
 * (Pollinations, no auth). Everything after generation is deterministic:
 * same input pixels -> same output pixels, every time.
 *
 * Pipeline: prompt -> row gen -> alpha cleanup -> frame extract -> atlas pack
 * ========================================================================== */

"use strict";

const $ = (s) => document.querySelector(s);

/* ---------------- utils ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fail(msg) { throw new Error(msg); }

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/* weighted euclidean color distance */
function colorDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);
}

/* ---------------- global state ---------------- */

const state = {
  category: "character",
  source: "ai",            // ai | procedural | upload
  key: { r: 255, g: 0, b: 255 },
  rows: [],                // [{ name, frames:[canvas], order:[idx], fps, loop }]
  originals: [],           // untouched extracted frames, parallel to rows
  revision: null,          // run-revision stamp; curation (order) is tied to it
  atlas: null,             // { canvas, manifest }
  busy: false,
  strict: false,           // retry mode: appends the strict isolation clause to prompts
};

/* non-destructive curation sidecar: order lives here, never in the frames */
function curation() {
  return { revision: state.revision, order: Object.fromEntries(state.rows.map(r => [r.name, r.order])) };
}

/* ---------------- stepper ---------------- */

const STEPS = ["prompt", "row", "alpha", "extract", "atlas", "done"];

function setStep(name, status, msg) {
  const li = document.querySelector(`#stepper li[data-step="${name}"]`);
  if (!li) return;
  li.classList.remove("active", "done", "error", "warn");
  if (status) li.classList.add(status);
  if (msg) stageMsg(msg, status === "error" ? "err" : status === "warn" ? "warn" : undefined);
}

function resetSteps() {
  document.querySelectorAll("#stepper li").forEach(li => li.classList.remove("active", "done", "error", "warn"));
}

function stageMsg(msg, kind) {
  const el = $("#stageMsg");
  el.textContent = msg;
  el.classList.toggle("err", kind === true || kind === "err");
  el.classList.toggle("warn", kind === "warn");
}

function showStage(canvas, msg) {
  const st = $("#stage");
  st.width = canvas.width; st.height = canvas.height;
  st.getContext("2d").drawImage(canvas, 0, 0);
  if (msg) stageMsg(msg);
}

/* drop the stage canvas so a fresh failure never sits under stale pixels
 * from a previous run (confusing: old strip + new error on top of it) */
function clearStage() {
  const st = $("#stage");
  st.width = 2; st.height = 2;
  st.getContext("2d").clearRect(0, 0, 2, 2);
  stageMsg("");
}

/* ---------------- per-category params UI ---------------- */

const CATEGORY_DEFAULTS = {
  character: { states: ["idle", "walk"], frames: 4, style: "clean 2d", view: "side", archetype: "biped", palette: "classic" },
  tile:      { size: 128, pattern: "grass" },
  ui:        { kind: "button", states: 3 },
  effect:    { type: "explosion", frames: 8 },
};

const STATE_FPS = { idle: 6, walk: 8, run: 10, jump: 8, attack: 10 };

function renderParams() {
  const cat = state.category;
  const box = $("#params");
  const d = CATEGORY_DEFAULTS[cat];

  if (cat === "character") {
    box.innerHTML = `
      <div class="field-label">Animation states <span class="dim">(one AI call per state)</span></div>
      <div class="row" id="stateRow">
        ${["idle", "walk", "run", "jump", "attack"].map(s =>
          `<label class="chk"><input type="checkbox" data-state="${s}" ${d.states.includes(s) ? "checked" : ""}>${s}</label>`).join("")}
      </div>
      <div class="row">
        <span class="dim">frames/state</span>
        <input type="number" class="num" id="pFrames" min="2" max="12" value="${d.frames}">
        <span class="dim">style</span>
        <select id="pStyle" class="grow">
          <option value="clean 2d">clean 2D</option>
          <option value="pixel art">pixel art</option>
          <option value="cartoon">cartoon</option>
          <option value="dark fantasy">dark fantasy</option>
        </select>
      </div>
      <div class="row">
        <span class="dim">view</span>
        <select id="pView"><option value="side">side</option><option value="front">front</option></select>
      </div>
      <div class="row">
        <span class="dim">archetype</span>
        <select id="pArch" class="grow">
          ${[["biped", "biped"], ["quadruped", "quadruped"], ["flyer", "flyer / bird"], ["slime", "slime"], ["robot", "robot"]]
            .map(([v, lbl]) => `<option value="${v}" ${v === d.archetype ? "selected" : ""}>${lbl}</option>`).join("")}
        </select>
        <span class="dim">palette</span>
        <select id="pPal">
          ${["classic", "ember", "frost", "toxic"].map(pl => `<option ${pl === d.palette ? "selected" : ""}>${pl}</option>`).join("")}
        </select>
        <button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button>
      </div>`;
  } else if (cat === "tile") {
    box.innerHTML = `
      <div class="field-label">Tile</div>
      <div class="row">
        <span class="dim">size</span>
        <select id="pSize">
          ${[32, 64, 128, 256].map(s => `<option value="${s}" ${s === d.size ? "selected" : ""}>${s}px</option>`).join("")}
        </select>
        <span class="dim">procedural pattern</span>
        <select id="pPattern" class="grow">
          ${TILE_PATTERNS.map(pat => `<option ${pat === d.pattern ? "selected" : ""}>${pat}</option>`).join("")}
        </select>
        <button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button>
      </div>
      <div class="dim" style="margin-bottom:4px">Tiles export edge-to-edge (no keying) and preview in a 3&times;3 wrap.</div>`;
  } else if (cat === "ui") {
    box.innerHTML = `
      <div class="field-label">UI element</div>
      <div class="row">
        <select id="pKind" class="grow">
          ${[["button", "button"], ["icon", "icon"], ["panel", "panel"], ["coin", "coin"], ["gem", "gem"], ["heart", "heart"], ["star", "star"], ["health", "health bar"]]
            .map(([v, lbl]) => `<option value="${v}" ${v === d.kind ? "selected" : ""}>${lbl}</option>`).join("")}
        </select>
        <span class="dim">variants</span>
        <input type="number" class="num" id="pStates" min="1" max="4" value="${d.states}">
        <button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button>
      </div>
      <div class="dim">Variants = normal / hover / pressed style states, extracted left to right.</div>`;
  } else {
    box.innerHTML = `
      <div class="field-label">Effect</div>
      <div class="row">
        <select id="pType" class="grow">
          ${["explosion", "fire", "smoke", "sparkle", "ring", "slash", "particles", "power-up", "magic"]
            .map(t => `<option ${t === d.type ? "selected" : ""}>${t}</option>`).join("")}
        </select>
        <span class="dim">frames</span>
        <input type="number" class="num" id="pFrames" min="4" max="16" value="${d.frames}">
        <button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button>
      </div>`;
  }

  const prompts = {
    character: "zombie pirate with a rusty hook hand",
    tile: "mossy dungeon floor stones",
    ui: "round fantasy RPG menu button, gold trim",
    effect: "fiery explosion with smoke",
  };
  $("#prompt").placeholder = "e.g. " + prompts[cat];

  // shuffle button: re-roll the procedural variant with a fresh random seed
  const sh = $("#pShuffle");
  if (sh) sh.onclick = () => runPipeline();
}

function readParams() {
  const cat = state.category;
  if (cat === "character") {
    const states = [...document.querySelectorAll("#stateRow input:checked")].map(i => i.dataset.state);
    return {
      states, frames: clampInt($("#pFrames").value, 2, 12, 4),
      style: $("#pStyle").value, view: $("#pView").value,
      archetype: $("#pArch").value, palette: $("#pPal").value,
    };
  }
  if (cat === "tile") return { size: +$("#pSize").value, pattern: $("#pPattern").value };
  if (cat === "ui") return { kind: $("#pKind").value, states: clampInt($("#pStates").value, 1, 4, 3) };
  return { type: $("#pType").value, frames: clampInt($("#pFrames").value, 4, 16, 8) };
}

function clampInt(v, lo, hi, fb) {
  v = parseInt(v, 10);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
}

function describe(fallback) {
  const t = $("#prompt").value.trim() || fallback;
  const b = boostPromptText(state.category, t);
  state.lastBoost = b;
  return b.text;
}

/* ---------------- prompt booster ----------------
 * One-word prompts ("Zombie") make the free model guess — and it guesses
 * badly. Short descriptions get auto-expanded with the style/view/structure/
 * palette guidance a sprite prompt needs. 8+ words are left alone. The exact
 * prompt sent to the AI is shown in the UI (collapsible) so it's never magic. */

const BOOST_BITS = {
  character: ["single character only, no extra figures or limbs", "bold readable silhouette",
    "limited harmonious color palette", "crisp clean edges", "game-ready sprite"],
  effect: ["bold simple shapes, readable at small size", "limited harmonious color palette",
    "smooth color falloff", "no smoke text artifacts"],
  ui: ["crisp vector-clean edges", "subtle depth, no photorealism", "limited harmonious color palette"],
  tile: ["cohesive limited color palette", "no focal object, pure texture", "even detail distribution"],
};

function boostPromptText(cat, raw) {
  const base = (raw || "").trim();
  if (!base) return { text: base, boosted: false };
  const words = base.split(/\s+/).filter(Boolean);
  if (words.length >= 8) return { text: base, boosted: false };
  const bits = BOOST_BITS[cat] || [];
  return { text: base + ", " + bits.join(", "), boosted: true };
}

function showPromptPeek(prompt) {
  $("#promptSent").textContent = prompt;
  $("#boostTag").hidden = !(state.lastBoost && state.lastBoost.boosted);
  $("#promptPeek").hidden = false;
}

/* ---------------- prompt builder ----------------
 * The model gets one row-strip per animation state on a flat chroma key,
 * with an explicit slot hint (one pose per invisible vertical slot).
 * Extraction is content-based, so the hint is a nudge, not a contract. */

function keyName() {
  const k = state.key;
  if (k.r === 255 && k.g === 0 && k.b === 255) return "magenta";
  if (k.r === 0 && k.g === 255 && k.b === 0) return "green";
  if (k.r === 0 && k.g === 120 && k.b === 255) return "blue";
  if (k.r === 255 && k.g === 255 && k.b === 255) return "white";
  return "black";
}

function buildPrompt(cat, p, sub, strict) {
  const key = keyName();
  // Flat-key phrasing is load-bearing: the model loves gradients/washes, and
  // anything but a solid single-color background defeats chroma extraction.
  const flatBg = `solid flat single-color ${key} background, absolutely no gradient, ` +
    `no shading, no vignette, no scenery, no floor, no backdrop details`;
  const strictClause = strict
    ? ` CRITICAL: every frame must be fully isolated — if any two frames touch, overlap, ` +
      `or merge into one shape the output is unusable. Keep wide empty ${key} gaps on all sides of each frame, ` +
      `and keep the background perfectly flat with zero gradient or shading.`
    : "";
  if (cat === "character") {
    return `2D game character sprite, ${describe("brave knight")}, ${p.style} style, ${(p.archetype || "biped")} body plan, ${sub} animation: ` +
      `${p.frames} SEPARATE non-overlapping poses in ONE horizontal row, ` +
      `large clear gaps of flat ${key} between every pose, ` +
      `poses never touching or blending into each other, each pose centered in its own slot, ` +
      `${p.view} view, full body visible, feet aligned on the same ground line, ` +
      `clean flat colors, bold readable silhouette, ` +
      flatBg + `, no shadows, no outline glow, no text, no watermark, game asset` + strictClause;
  }
  if (cat === "tile") {
    return `seamless tileable 2D game texture, ${describe("mossy dungeon floor")}, ` +
      `fills the entire square image edge to edge, repeating pattern with no visible seams, ` +
      `flat game art, no characters, no text, no watermark`;
  }
  if (cat === "ui") {
    return `2D game UI ${p.kind}, ${describe("round fantasy RPG menu button")}, ` +
      `${p.states} SEPARATE non-overlapping variations in ONE horizontal row left to right (normal, hover, pressed states), ` +
      `large clear gaps of flat ${key} between variations, never touching, ` +
      `each centered in its own slot, clean vector game UI style, ` +
      flatBg + `, no text letters, no watermark` + strictClause;
  }
  return `2D game effect sprite sequence, ${describe("fiery explosion")}, ${p.type} effect, ` +
    `${p.frames} SEPARATE non-overlapping frames in ONE horizontal row left to right, ` +
    `showing the burst progression from ignition to dissipation, each burst stage centered in its own slot, ` +
    `large clear gaps of flat ${key} between every frame, ` +
    `frames never touching, overlapping, or blending into each other, ` +
    `vibrant flat game art, ` + flatBg + `, no text, no watermark` + strictClause;
}

/* ---------------- AI row generation (Pollinations, no auth) ---------------- */

/* ---------------- AI fetch with retry ----------------
 * Pollinations rate-limits anonymous bursts (HTTP 402/429). Retry with
 * exponential backoff: immediate, +3s, +9s. 402/429/5xx and network
 * errors are retryable; other 4xx fail fast. onAttempt(n, total) drives
 * the stepper so the user sees "Row gen — retry 2/3…" instead of silence. */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function retryableStatus(s) { return s === 402 || s === 429 || s >= 500; }

async function fetchWithRetry(url, onAttempt) {
  const delays = [0, 3000, 9000];
  let lastStatus = 0;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await sleep(delays[i]);
    if (onAttempt) { try { onAttempt(i + 1, delays.length); } catch (e) {} }
    let res;
    try {
      res = await fetch(url, { mode: "cors" });
    } catch (e) {
      continue; // network blip — transient, retry
    }
    if (res.ok) return res;
    lastStatus = res.status;
    if (!retryableStatus(res.status)) {
      fail(`image request failed (HTTP ${res.status}) — not retryable; try Procedural mode`);
    }
    // else: loop for another attempt
  }
  fail(`AI_RATE_LIMITED: Pollinations is rate-limiting free requests right now` +
    (lastStatus ? ` (HTTP ${lastStatus} after 3 tries)` : ` (network unreachable after 3 tries)`) +
    `. Wait a minute and retry, or use Procedural mode.`);
}

async function fetchImageBitmap(url, onAttempt) {
  const res = await fetchWithRetry(url, onAttempt);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function pollinationsURL(prompt, w, h, seed) {
  return "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
    `?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux`;
}

async function genRowAI(prompt, frames, cellH, label) {
  // Wide strip: one cell per frame. Keep the strip >=1024px wide so frames
  // carry usable detail (the model returns blurry mush at small sizes).
  const h = cellH || 384;
  const w = Math.min(2048, Math.max(1024, h * frames));
  const seed = (Math.random() * 1e9) | 0;
  const url = pollinationsURL(prompt, w, h, seed);
  const bmp = await fetchImageBitmap(url, (n, total) => {
    if (n > 1) setStep("row", "active", `row gen [${label}] — retry ${n}/${total}…`);
  });
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  return c;
}

/* ---------------- alpha cleanup: chroma key + despill ----------------
 * Hard-key pixels inside the color-distance ball, then soft-alpha + despill
 * on the anti-aliased fringe so silhouettes keep clean edges instead of
 * getting chewed into a hard cut. Key is chosen away from the subject hue. */

function chromaKey(src, key, threshold = 60, fringe = 40) {
  const w = src.width, h = src.height;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  const img = sctx.getImageData(0, 0, w, h);
  const d = img.data;

  // key dominance vector: which channels the key color "owns" (for despill)
  const lum = (key.r + key.g + key.b) / 3;
  const kd = [Math.max(0, key.r - lum), Math.max(0, key.g - lum), Math.max(0, key.b - lum)];

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const dist = colorDist(r, g, b, key.r, key.g, key.b);

    if (dist <= threshold) {
      d[i + 3] = 0; // fully keyed out
    } else if (dist <= threshold + fringe) {
      // fringe: soft alpha + despill (pull rgb away from the key color)
      const f = (dist - threshold) / fringe;      // 0 at key edge -> 1 at clean
      const spill = (1 - f) * 0.85;
      d[i]     = Math.max(0, r - spill * kd[0]);
      d[i + 1] = Math.max(0, g - spill * kd[1]);
      d[i + 2] = Math.max(0, b - spill * kd[2]);
      d[i + 3] = Math.round(255 * f);
    }
  }

  const out = makeCanvas(w, h);
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}
/* ---------------- frame extraction ----------------
 * Content-based, not slot-based: flood-fill alpha blobs, take the N biggest
 * as pose seeds, sort left-to-right, attach stray blobs to the nearest seed,
 * crop + fit each into its cell. If N poses can't be recovered we FAIL LOUDLY
 * — no silent slot fallback, no guessed frames. */

function extractFrames(strip, count, opts = {}) {
  const align = opts.align || "bottom"; // bottom | center
  const w = strip.width, h = strip.height;
  const ctx = strip.getContext("2d", { willReadFrequently: true });
  const px = ctx.getImageData(0, 0, w, h).data;
  const visited = new Uint8Array(w * h);
  const comps = [];
  const stack = [];

  const alphaAt = (x, y) => px[(y * w + x) * 4 + 3];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (visited[idx] || alphaAt(x, y) <= 12) continue;
      // flood fill this blob
      let x0 = x, x1 = x, y0 = y, y1 = y, area = 0, sx = 0;
      stack.push(idx);
      visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % w, cy = (cur / w) | 0;
        area++; sx += cx;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        // 4-neighbors
        if (cx > 0) { const n = cur - 1; if (!visited[n] && px[n * 4 + 3] > 12) { visited[n] = 1; stack.push(n); } }
        if (cx < w - 1) { const n = cur + 1; if (!visited[n] && px[n * 4 + 3] > 12) { visited[n] = 1; stack.push(n); } }
        if (cy > 0) { const n = cur - w; if (!visited[n] && px[n * 4 + 3] > 12) { visited[n] = 1; stack.push(n); } }
        if (cy < h - 1) { const n = cur + w; if (!visited[n] && px[n * 4 + 3] > 12) { visited[n] = 1; stack.push(n); } }
      }
      comps.push({ x0, x1, y0, y1, area, cx: sx / area });
    }
  }

  let totalAlpha = 0;
  for (const c of comps) totalAlpha += c.area;
  if (totalAlpha === 0) fail("extraction found zero non-transparent pixels — the whole strip keyed out. Try a different background key color.");

  // noise floor: drop specks
  const kept = comps.filter(c => c.area >= Math.max(60, totalAlpha * 0.0015));
  kept.sort((a, b) => b.area - a.area);

  if (kept.length < count) {
    fail(`extraction recovered ${kept.length} pose blob${kept.length === 1 ? "" : "s"} but needs ${count}. ` +
      `The AI strip probably merged poses or left the key in. Regenerate the row or lower the frame count.`);
  }
  const seeds = kept.slice(0, count);

  // attach remaining blobs to the nearest seed by x-center
  const groups = seeds.map(s => ({ seed: s, blobs: [s] }));
  for (let i = count; i < kept.length; i++) {
    const c = kept[i];
    let best = null, bestD = Infinity;
    for (const g of groups) {
      const dd = Math.abs(c.cx - g.seed.cx);
      if (dd < bestD) { bestD = dd; best = g; }
    }
    if (bestD < w / count) best.blobs.push(c);
    // else: unattached noise, dropped
  }

  // sanity: every seed must own a meaningful share of the ink
  for (const g of groups) {
    const ga = g.blobs.reduce((a, b) => a + b.area, 0);
    if (ga < totalAlpha * 0.01) {
      fail(`one recovered pose owns <1% of the sprite ink — the strip is malformed. Regenerate the row.`);
    }
  }

  // sort left to right, fit into cells
  groups.sort((a, b) => a.seed.cx - b.seed.cx);
  const cellW = Math.ceil(w / count), cellH = h;
  const frames = groups.map(g => {
    let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
    for (const b of g.blobs) {
      x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1);
      y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1);
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // never upscale: scale <= 1.0, aspect-preserving
    const s = Math.min((cellW * 0.94) / bw, (cellH * 0.94) / bh, 1);
    const dw = Math.max(1, Math.round(bw * s)), dh = Math.max(1, Math.round(bh * s));
    const cell = makeCanvas(cellW, cellH);
    const cctx = cell.getContext("2d");
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = "high";
    const dx = Math.round((cellW - dw) / 2);
    const dy = align === "bottom"
      ? Math.round(cellH - dh - cellH * 0.03)
      : Math.round((cellH - dh) / 2);
    cctx.drawImage(strip, x0, y0, bw, bh, dx, dy, dw, dh);
    return cell;
  });

  return frames;
}

/* ---------------- key-coverage sanity check ----------------
 * The model sometimes ignores the flat-background instruction and returns a
 * gradient/wash instead — chroma keying can't cleanly strip that. Measure how
 * much of the strip actually keyed out (alpha <= 12); if it's suspiciously
 * low, warn amber and offer the retry path instead of failing silently later. */

function checkKeyCoverage(keyed) {
  const w = keyed.width, h = keyed.height;
  const d = keyed.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let clear = 0, sampled = 0;
  for (let i = 3; i < d.length; i += 16) { // sample every 4th pixel
    sampled++;
    if (d[i] <= 12) clear++;
  }
  const cov = clear / sampled;
  if (cov < 0.30) {
    stageMsg(`background isn't flat — key covered only ${Math.round(cov * 100)}% of the strip. Extraction may be messy.`, "warn");
    showRetry(`Background came back as a gradient/wash instead of flat ${keyName()}. ` +
      `Retry with a stricter prompt, or pick a different background key.`);
    return false;
  }
  return true;
}

/* ---------------- slot-slice fallback ----------------
 * When blob recovery can't find N poses (merged strip, leftover key wash),
 * slice the strip into N even slots and content-crop each slot instead of
 * dying. Frames are flagged slotSliced:true in the manifest — amber warning,
 * not a red dead end. Loud fail remains only when there is no ink at all. */

function sliceSlots(strip, count, opts = {}) {
  const align = opts.align || "bottom";
  const w = strip.width, h = strip.height;
  const ctx = strip.getContext("2d", { willReadFrequently: true });
  const px = ctx.getImageData(0, 0, w, h).data;
  const slotW = w / count;
  const frames = [];
  for (let s = 0; s < count; s++) {
    const sx0 = Math.floor(s * slotW), sx1 = Math.min(w, Math.ceil((s + 1) * slotW));
    let x0 = sx1, x1 = sx0, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = sx0; x < sx1; x++) {
        if (px[(y * w + x) * 4 + 3] > 12) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    const cell = makeCanvas(Math.ceil(slotW), h);
    const cctx = cell.getContext("2d");
    if (x1 >= x0) {
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const sc = Math.min((slotW * 0.94) / bw, (h * 0.94) / bh, 1);
      const dw = Math.max(1, Math.round(bw * sc)), dh = Math.max(1, Math.round(bh * sc));
      const dx = Math.round((slotW - dw) / 2);
      const dy = align === "bottom" ? Math.round(h - dh - h * 0.03) : Math.round((h - dh) / 2);
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = "high";
      cctx.drawImage(strip, x0, y0, bw, bh, dx, dy, dw, dh);
    }
    frames.push(cell);
  }
  return frames;
}

function extractFramesRobust(strip, count, opts = {}) {
  try {
    return { frames: extractFrames(strip, count, opts), method: "blobs" };
  } catch (e) {
    if (/zero non-transparent pixels/.test(e.message)) throw e; // nothing to slice
    return { frames: sliceSlots(strip, count, opts), method: "slots", warning: e.message };
  }
}

function noteExtraction(ex, count, unit) {
  if (ex.method === "slots") {
    setStep("extract", "warn", `slot-sliced ${ex.frames.length}/${count} ${unit} (even slots — verify edges)`);
    stageMsg(`blob recovery failed (${ex.warning}) — fell back to even slot slicing. ` +
      `Frames flagged slotSliced in the manifest; check edges before shipping.`, "warn");
  } else {
    setStep("extract", "done", `extracted ${ex.frames.length}/${count} ${unit}`);
  }
  return ex.method === "slots";
}

/* ---------------- retry bar (recovery path, not a dead end) ---------------- */

function hideRetry() { $("#retryBar").hidden = true; }
function showRetry(msg) {
  $("#retryMsg").textContent = msg;
  $("#retryBar").hidden = false;
}

function setBusy(b) {
  state.busy = b;
  document.querySelectorAll(".generate").forEach(x => { x.disabled = b; });
}

/* ---------------- atlas packing + manifest ----------------
 * Contract (borrowed from the component-row playbook):
 * atlas = one state per row, frames left-to-right;
 * manifest carries absolute frame rects + per-state fps/durations + loop flags.
 * Game code consumes the rects — it never recomputes them. */

function buildAtlas(rows, pad = 2) {
  const rowCells = rows.map(r => {
    let cw = 0, ch = 0;
    for (const f of r.frames) { cw = Math.max(cw, f.width); ch = Math.max(ch, f.height); }
    return { cw, ch };
  });
  const sheetW = Math.max(...rows.map((r, i) => rowCells[i].cw * r.frames.length + pad * 2));
  const sheetH = rowCells.reduce((a, c) => a + c.ch, 0) + pad * (rows.length + 1);

  const sheet = makeCanvas(sheetW, sheetH);
  const sctx = sheet.getContext("2d");

  const frameLayout = { padding: pad, rows: {} };
  const animations = {};
  let y = pad;

  rows.forEach((r, ri) => {
    const { cw, ch } = rowCells[ri];
    const rects = [];
    r.order.forEach((fi, i) => {
      const f = r.frames[fi];
      const x = pad + i * cw;
      sctx.drawImage(f, x, y);
      rects.push({ x, y, w: cw, h: ch });
    });
    frameLayout.rows[r.name] = { row: ri, cellWidth: cw, cellHeight: ch, rects };
    const fps = r.fps || 8;
    animations[r.name] = {
      row: ri,
      frames: r.order.length,
      fps,
      loop: r.loop !== false,
      durationsMs: r.order.map(() => Math.round(1000 / fps)),
      frameOrder: r.order.slice(),
      slotSliced: !!r.slotSliced, // true when blob recovery failed and even slots were cut
    };
    y += ch + pad;
  });

  const manifest = {
    tool: "m4ster-sprite-gen",
    version: "2.0.0",
    engine: "component-row",
    runRevision: state.revision,
    atlas: "m4ster-sprite-sheet.png",
    sheetWidth: sheetW,
    sheetHeight: sheetH,
    frameLayout,
    animations,
    curation: curation(),
  };

  return { canvas: sheet, manifest };
}

/* ---------------- frames strip UI (non-destructive reorder) ---------------- */

function renderFramesUI() {
  const box = $("#framesRow");
  box.innerHTML = "";
  let total = 0;

  state.rows.forEach((r, ri) => {
    r.order.forEach((fi, oi) => {
      total++;
      const card = document.createElement("div");
      card.className = "frame-card";
      const cv = document.createElement("canvas");
      cv.width = r.frames[fi].width; cv.height = r.frames[fi].height;
      cv.getContext("2d").drawImage(r.frames[fi], 0, 0);
      cv.title = "click to download this frame";
      cv.style.cursor = "pointer";
      cv.onclick = () => downloadCanvas(cv, `m4ster-${r.name}-frame${oi}.png`);
      card.appendChild(cv);
      const nm = document.createElement("span");
      nm.className = "fname";
      nm.textContent = `${r.name} · ${oi + 1}`;
      card.appendChild(nm);
      const mv = document.createElement("div");
      mv.className = "mv";
      const left = document.createElement("button");
      left.textContent = "◀"; left.title = "move earlier";
      left.onclick = () => moveFrame(ri, oi, -1);
      const right = document.createElement("button");
      right.textContent = "▶"; right.title = "move later";
      right.onclick = () => moveFrame(ri, oi, 1);
      mv.appendChild(left); mv.appendChild(right);
      card.appendChild(mv);
      box.appendChild(card);
    });
  });

  $("#framesMeta").textContent = total ? `· ${total} frames, rev ${state.revision}` : "";
}

function moveFrame(ri, oi, dir) {
  const r = state.rows[ri];
  const ni = oi + dir;
  if (ni < 0 || ni >= r.order.length) return;
  const o = r.order;
  [o[oi], o[ni]] = [o[ni], o[oi]];
  // rebuild atlas so the manifest order matches (originals untouched)
  state.atlas = buildAtlas(state.rows);
  renderFramesUI();
  showStage(state.atlas.canvas, `atlas rebuilt — frame order now [${r.order.join(", ")}] (rev ${state.revision})`);
}

/* ---------------- animated preview ---------------- */

let previewRAF = 0, previewRow = 0, previewT = 0;

function startPreview() {
  cancelAnimationFrame(previewRAF);
  const sel = $("#previewState");
  sel.innerHTML = "";
  state.rows.forEach((r, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = r.name;
    sel.appendChild(o);
  });
  if (!state.rows.length) return;
  previewRow = 0;
  sel.onchange = () => { previewRow = +sel.value; previewT = 0; };

  const pc = $("#preview");
  const pctx = pc.getContext("2d");
  pctx.imageSmoothingEnabled = false;
  let last = performance.now();

  function tick(now) {
    previewRAF = requestAnimationFrame(tick);
    const r = state.rows[previewRow];
    if (!r) return;
    const fps = +$("#previewFps").value || 8;
    if (now - last < 1000 / fps) return;
    last = now;
    previewT = (previewT + 1) % r.order.length;
    const f = r.frames[r.order[previewT]];
    pctx.clearRect(0, 0, pc.width, pc.height);

    if (r.tileable) {
      // 3x3 wrap check
      const tw = f.width, th = f.height;
      const s = Math.min(pc.width / (tw * 3), pc.height / (th * 3));
      const dw = tw * s, dh = th * s;
      const ox = (pc.width - dw * 3) / 2, oy = (pc.height - dh * 3) / 2;
      for (let iy = 0; iy < 3; iy++)
        for (let ix = 0; ix < 3; ix++)
          pctx.drawImage(f, ox + ix * dw, oy + iy * dh, dw, dh);
      $("#previewMeta").textContent = `· ${r.name} · 3×3 tile check`;
    } else {
      const s = Math.min(pc.width / f.width, pc.height / f.height, 8);
      const dw = Math.max(1, Math.round(f.width * s)), dh = Math.max(1, Math.round(f.height * s));
      pctx.drawImage(f, (pc.width - dw) / 2, (pc.height - dh) / 2, dw, dh);
      $("#previewMeta").textContent = `· ${r.name} · frame ${previewT + 1}/${r.order.length}`;
    }
  }
  tick(last);
}

/* ---------------- export ---------------- */

function downloadCanvas(canvas, filename) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function wireExport() {
  $("#dlSheet").onclick = () => state.atlas && downloadCanvas(state.atlas.canvas, "m4ster-sprite-sheet.png");
  $("#dlJson").onclick = () => state.atlas && downloadJSON(state.atlas.manifest, "m4ster-sprite-atlas.json");
  $("#dlFrames").onclick = () => {
    if (!state.rows.length) return;
    let delay = 0;
    state.rows.forEach(r => {
      r.order.forEach((fi, oi) => {
        setTimeout(() => downloadCanvas(r.frames[fi], `m4ster-${r.name}-frame${oi}.png`), delay);
        delay += 350;
      });
    });
  };
}

function enableExport(on) {
  ["#dlSheet", "#dlJson", "#dlFrames"].forEach(s => { $(s).disabled = !on; });
}
/* ================= procedural (offline) generators =================
 * Seeded pixel-art mode: palette-locked, selective outline, binary alpha.
 * Zero network. Deterministic: same seed -> same pixels. */

function px(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/* dark outline around the silhouette: any transparent pixel touching ink */
function selectiveOutline(canvas, color) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const mark = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] !== 0) continue;
      const n = (nx, ny) => nx >= 0 && ny >= 0 && nx < w && ny < h && d[(ny * w + nx) * 4 + 3] > 0;
      if (n(x - 1, y) || n(x + 1, y) || n(x, y - 1) || n(x, y + 1)) mark.push(i);
    }
  }
  const c = hexRGB(color);
  for (const i of mark) { d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
}

function hexRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* limb from pivot: angle 0 = down, positive swings forward. returns endpoint */
function limb(ctx, x0, y0, len, angDeg, w, color) {
  const a = (angDeg * Math.PI) / 180;
  const dx = Math.sin(a), dy = Math.cos(a);
  ctx.fillStyle = color;
  for (let i = 0; i <= len; i++) {
    ctx.fillRect(Math.round(x0 + dx * i - w / 2), Math.round(y0 + dy * i), w, 1);
  }
  return [x0 + dx * len, y0 + dy * len];
}

/* procedural palettes: 4 named sets shared by every offline generator.
 * jitter keeps repeats from looking stamped; same seed -> same pixels. */
const PROC_PALETTES = {
  classic: { skin: ["#f2c69b", "#e0a878", "#c98a5b", "#a96f45"], hue: 210, accent: 45 },
  ember:   { skin: ["#f0b489", "#d99668", "#b57a4e", "#8f5c38"], hue: 12,  accent: 48 },
  frost:   { skin: ["#f6d7b8", "#e8b98f", "#cfa06f", "#a87f52"], hue: 200, accent: 185 },
  toxic:   { skin: ["#cfe8a8", "#a8d47e", "#7fb85a", "#5c9440"], hue: 95,  accent: 300 },
};

function procPalette(name, rng) {
  const P = PROC_PALETTES[name] || PROC_PALETTES.classic;
  const hue = (((P.hue + (((rng() * 24) | 0) - 12)) % 360) + 360) % 360;
  return {
    skin: P.skin[(rng() * P.skin.length) | 0],
    cloth: `hsl(${hue},55%,52%)`,
    clothD: `hsl(${hue},55%,36%)`,
    pants: `hsl(${(hue + 40) % 360},25%,30%)`,
    accent: `hsl(${P.accent},75%,58%)`,
    dark: "#141414",
  };
}

const SKIN = ["#f2c69b", "#e0a878", "#c98a5b", "#a96f45"]; // legacy alias, kept for compat

function procCharacter(p, stateName, seedNum) {
  const arch = p.archetype || "biped";
  if (arch === "quadruped") return procQuadruped(p, stateName, seedNum);
  if (arch === "flyer")     return procFlyer(p, stateName, seedNum);
  if (arch === "slime")     return procSlime(p, stateName, seedNum);
  if (arch === "robot")     return procRobot(p, stateName, seedNum);
  return procBiped(p, stateName, seedNum);
}

function procBiped(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919);
  const count = p.frames;
  const W = 32, H = 44, S = 4;
  const pal = procPalette(p.palette, rng);
  const skin = pal.skin, shirt = pal.cloth, shirtD = pal.clothD, pants = pal.pants;
  const hairC = ["#2b2b2b", "#5a3a22", "#8a5a2b", "#d8d8d8"][(rng() * 4) | 0];

  const strip = makeCanvas(W * count * S, H * S);

  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let bob = 0, legL = 0, legR = 0, armL = 8, armR = 8, lean = 0;

    if (stateName === "walk")      { legL = Math.sin(ph) * 32; legR = -Math.sin(ph) * 32; armL = -Math.sin(ph) * 26; armR = Math.sin(ph) * 26; bob = Math.abs(Math.sin(ph)); }
    else if (stateName === "run")  { legL = Math.sin(ph) * 52; legR = -Math.sin(ph) * 52; armL = -Math.sin(ph) * 45; armR = Math.sin(ph) * 45; bob = Math.abs(Math.sin(ph)) * 2; lean = 3; }
    else if (stateName === "jump") {
      const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI); // crouch -> apex -> land
      bob = Math.round(air * 4) - ((k < 0.25 || k > 0.75) ? 1 : 0);
      legL = Math.round(-15 - air * 40); legR = Math.round(10 + air * 20);
      armL = Math.round(-40 - air * 100); armR = Math.round(-60 - air * 100);
      lean = Math.round(air * 2);
    }
    else if (stateName === "attack") {
      const k = f / Math.max(1, count - 1);           // windup -> strike
      armR = -60 + k * 130; legL = 25; legR = -20; lean = k * 4; bob = 1;
    }
    else { bob = (f % 2); armL = 6 + Math.sin(ph) * 4; armR = 6 - Math.sin(ph) * 4; } // idle

    const Y = (y) => y - Math.round(bob);

    // far limbs first (darker), then body, then near limbs
    limb(ctx, 13, Y(24), 12, legR * 0.9, 4, pants);
    limb(ctx, 9, Y(15), 9, armL, 3, shirtD);
    // head + hair
    px(ctx, 11, Y(4), 10, 9, skin);
    px(ctx, 10, Y(2), 12, 4, hairC); px(ctx, 10, Y(5), 2, 6, hairC); px(ctx, 20, Y(5), 2, 6, hairC);
    px(ctx, 14, Y(8), 1, 2, "#1a1a1a"); px(ctx, 17, Y(8), 1, 2, "#1a1a1a");
    // torso + belt
    px(ctx, 10 + lean * 0.2, Y(14), 12, 9, shirt);
    px(ctx, 10, Y(22), 12, 2, "#333");
    // near limbs
    const [hx, hy] = limb(ctx, 19, Y(24), 12, legL, 4, pants);
    px(ctx, hx - 2, hy, 5, 2, "#222");                       // boot
    const [ax, ay] = limb(ctx, 23, Y(15), 9, armR, 3, shirt);
    px(ctx, Math.round(ax) - 1, Math.round(ay), 3, 3, skin); // hand
    if (stateName === "attack") {
      const [sx, sy] = limb(ctx, ax, ay, 12, armR, 2, "#cfd6dd"); // sword
      if (f > 0 && f < count - 1) px(ctx, sx - 1, sy - 1, 3, 3, "#fff8c9"); // strike spark
    }

    selectiveOutline(cell, "#141414");

    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* quadruped: horizontal body, diagonal leg pairs, tail wag. faces right. */
function procQuadruped(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 101);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 44, H = 32, S = 4;
  const fur = pal.cloth, furD = pal.clothD, belly = pal.skin;
  const strip = makeCanvas(W * count * S, H * S);
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let bob = 0, lunge = 0, headDy = 0;
    let sw = [0, 0, 0, 0]; // [frontL, frontR, backL, backR]
    if (stateName === "walk")      { const a = Math.sin(ph) * 28; sw = [a, -a, -a, a]; bob = Math.abs(Math.sin(ph)); }
    else if (stateName === "run")  { const a = Math.sin(ph) * 46; sw = [a, -a, -a, a]; bob = Math.abs(Math.sin(ph)) * 2; lunge = 1; }
    else if (stateName === "jump") {
      const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI);
      const tuck = Math.round(air * 40);
      sw = [-tuck, -tuck, tuck, tuck];
      bob = Math.round(air * 4);
      headDy = Math.round(-air * 2);
    }
    else if (stateName === "attack") { const k = f / Math.max(1, count - 1); lunge = Math.round(k * 5); headDy = Math.round(k * 4); sw = [20, 20, -15, -15]; }
    else { bob = (f % 2); headDy = Math.round(Math.sin(ph)); }
    const Y = (y) => y - Math.round(bob);
    const legX = [15, 21, 27, 33];
    limb(ctx, legX[1], Y(22), 8, sw[1] * 0.9, 3, furD);   // far legs first
    limb(ctx, legX[3], Y(22), 8, sw[3] * 0.9, 3, furD);
    limb(ctx, 10, Y(14), 8, -35 + Math.sin(ph * 2) * 12, 3, furD); // tail wag
    px(ctx, 12 + lunge, Y(11), 22, 10, fur);               // body
    px(ctx, 12 + lunge, Y(18), 22, 3, belly);              // belly
    px(ctx, 12 + lunge, Y(11), 22, 2, furD);               // back ridge
    px(ctx, 32 + lunge, Y(5) + headDy, 9, 9, fur);         // head
    px(ctx, 33 + lunge, Y(3) + headDy, 4, 3, furD);        // ear
    px(ctx, 37 + lunge, Y(8) + headDy, 2, 2, "#1a1a1a");   // eye
    px(ctx, 40 + lunge, Y(10) + headDy, 2, 2, "#1a1a1a");  // nose
    limb(ctx, legX[0], Y(22), 8, sw[0], 3, fur);          // near legs
    const [hx, hy] = limb(ctx, legX[2], Y(22), 8, sw[2], 3, fur);
    px(ctx, Math.round(hx) - 2, Math.round(hy), 5, 2, "#222");
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* flyer/bird: side view, one big flapping wing. faces right. */
function procFlyer(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 202);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 36, H = 36, S = 4;
  const body = pal.cloth, bodyD = pal.clothD;
  const strip = makeCanvas(W * count * S, H * S);
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let flapSpeed = 1, flapAmp = 30, bobA = 1, lean = 0, dive = 0;
    if (stateName === "walk")        { flapSpeed = 3; flapAmp = 55; bobA = 2; }
    else if (stateName === "run")   { flapSpeed = 3; flapAmp = 65; bobA = 2; lean = 2; }
    else if (stateName === "jump")  { flapAmp = 70; bobA = 3; }
    else if (stateName === "attack") { dive = 1; flapAmp = 75; lean = 4; }
    const flap = Math.sin(ph * flapSpeed) * flapAmp;
    const bob = Math.abs(Math.sin(ph * flapSpeed)) * bobA;
    const Y = (y) => y - Math.round(bob) + (dive ? 4 : 0);
    limb(ctx, 16, Y(16), 10, -40 - flap * 0.7, 3, bodyD);  // far wing
    limb(ctx, 10, Y(20), 8, 55, 3, bodyD);                 // tail feathers
    limb(ctx, 10, Y(20), 8, 75, 3, bodyD);
    px(ctx, 12 + lean, Y(14), 13, 11, body);              // body
    px(ctx, 12 + lean, Y(22), 13, 3, bodyD);
    px(ctx, 23 + lean, Y(10), 8, 8, body);                // head
    px(ctx, 30 + lean, Y(12), 4, 3, "#f5a623");           // beak
    px(ctx, 26 + lean, Y(12), 2, 2, "#1a1a1a");           // eye
    px(ctx, 24 + lean, Y(7), 2, 3, pal.accent);            // crest
    const [wx, wy] = limb(ctx, 17 + lean, Y(15), 13, -55 - flap, 4, body); // near wing
    px(ctx, Math.round(wx) - 2, Math.round(wy) - 1, 5, 3, bodyD);
    px(ctx, 16 + lean, Y(26), 3, 2, "#d98a2b");            // tucked feet
    px(ctx, 21 + lean, Y(26), 3, 2, "#d98a2b");
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* slime/blob: squash & stretch. the hop IS the walk cycle. */
function procSlime(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 303);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 36, H = 32, S = 4;
  const goo = pal.cloth, gooL = pal.accent;
  const strip = makeCanvas(W * count * S, H * S);
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let bw = 24, bh = 18, yOff = 0, xOff = 0;
    if (stateName === "idle")      { const s = Math.sin(ph); bh += Math.round(s); bw -= Math.round(s); }
    else if (stateName === "walk") { const a = Math.abs(Math.sin(ph)); yOff = -Math.round(a * 6); bh += Math.round(a * 4); bw -= Math.round(a * 3); }
    else if (stateName === "run")  { const a = Math.abs(Math.sin(ph)); yOff = -Math.round(a * 8); bh += Math.round(a * 5); bw -= Math.round(a * 4); }
    else if (stateName === "jump") { const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI); yOff = -Math.round(air * 8); bh += Math.round(air * 5); bw -= Math.round(air * 3); }
    else if (stateName === "attack") { const k = f / Math.max(1, count - 1); bw += Math.round(k * 8); xOff = Math.round(k * 5); bh -= Math.round(k * 2); }
    const cx = 18 + xOff, baseY = 28 + yOff - bh;
    px(ctx, cx - bw / 2 + 2, baseY + 3, bw - 4, bh - 3, goo);
    px(ctx, cx - bw / 2, baseY + 6, bw, bh - 6, goo);
    px(ctx, cx - bw / 2 + 2, baseY, bw - 4, 6, gooL);
    px(ctx, cx - bw / 2 + 1, baseY + 2, 3, 3, "#ffffff");
    const ey = baseY + 8;
    px(ctx, cx - 7, ey, 4, 5, "#ffffff"); px(ctx, cx + 3, ey, 4, 5, "#ffffff");
    px(ctx, cx - 6, ey + 2, 2, 2, "#1a1a1a"); px(ctx, cx + 4, ey + 2, 2, 2, "#1a1a1a");
    if (stateName === "attack") px(ctx, cx - 4, ey + 7, 8, 2, "#1a1a1a");
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* robot: blocky, rigid servo angles (quantized to 15°), blinking visor. */
function procRobot(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 404);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 32, H = 44, S = 4;
  const metal = "#9aa3ad", metalD = "#6b7280", joint = "#3f4750";
  const strip = makeCanvas(W * count * S, H * S);
  const quant = (a) => Math.round(a / 15) * 15;
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let legL = 0, legR = 0, armL = 10, armR = 10, bob = 0, cannon = false;
    if (stateName === "walk")      { legL = quant(Math.sin(ph) * 30); legR = -legL; armL = quant(-legL * 0.8); armR = quant(-legR * 0.8); bob = Math.abs(Math.sin(ph)) > 0.5 ? 1 : 0; }
    else if (stateName === "run")  { legL = quant(Math.sin(ph) * 45); legR = -legL; armL = -legL; armR = -legR; bob = 1; }
    else if (stateName === "jump") {
      const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI);
      legL = Math.round(-15 - air * 35); legR = Math.round(10 + air * 25);
      armL = Math.round(-40 - air * 80); armR = Math.round(-60 - air * 80);
      bob = Math.round(air * 4);
    }
    else if (stateName === "attack") { cannon = true; armR = 90; legL = 15; legR = -15; }
    else { armL = 8 + Math.sin(ph) * 3; armR = 8 - Math.sin(ph) * 3; }
    const Y = (y) => y - bob;
    for (const [hx, ang, col] of [[13, legL, metalD], [19, legR, metal]]) {
      const [kx, ky] = limb(ctx, hx, Y(26), 7, quant(ang), 4, joint);
      const [fx, fy] = limb(ctx, kx, ky, 7, quant(ang * 0.4), 4, col);
      px(ctx, Math.round(fx) - 2, Math.round(fy), 5, 2, "#222");
    }
    px(ctx, 10, Y(14), 12, 11, metal);
    px(ctx, 10, Y(14), 12, 2, metalD);
    px(ctx, 14, Y(18), 4, 4, pal.accent);
    px(ctx, 11, Y(4), 10, 8, metal);
    const visorOn = !(stateName === "idle" && f % 4 === 3);
    px(ctx, 12, Y(6), 8, 3, visorOn ? pal.accent : joint);
    px(ctx, 15, Y(2), 2, 2, joint);
    px(ctx, 15, Y(0), 2, 2, (f % 2) ? pal.accent : joint);
    for (const [sx, ang] of [[9, armL], [23, armR]]) {
      const [ex, ey] = limb(ctx, sx, Y(15), 7, quant(ang), 4, joint);
      limb(ctx, ex, ey, 6, quant(ang * 0.6), 4, metal);
    }
    if (cannon) {
      limb(ctx, 23, Y(15), 12, 90, 5, metalD);
      px(ctx, 30, Y(13), 4, 5, pal.accent);
      if (f % 2 === 0) px(ctx, 34, Y(12), 3, 7, "#fff8c9");
    }
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* wrapped drawing helper: features drawn at 9 offsets tile seamlessly */
function wrapped(ctx, s, fn) {
  for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
    ctx.save(); ctx.translate(ox, oy); fn(); ctx.restore();
  }
}

const TILE_PATTERNS = ["grass", "sand", "stone", "brick", "wood", "metal", "water", "dungeon"];

/* returns an ARRAY of canvases (water shimmers: 2 frames, everything else 1) */
function procTile(pattern, size, seedNum) {
  const frames = pattern === "water" ? 2 : 1;
  const out = [];
  for (let fr = 0; fr < frames; fr++) {
    const rng = mulberry32(seedNum + fr * 131);
    const S = 32;
    const base = makeCanvas(S, S);
    const ctx = base.getContext("2d");
    const R = (a, b) => a + rng() * (b - a);

    if (pattern === "grass") {
      px(ctx, 0, 0, S, S, "#4d9247");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 26; i++) px(ctx, R(0, S), R(0, S), 1, 1, rng() < 0.5 ? "#3d7a3a" : "#5fa855");
        for (let i = 0; i < 6; i++) { const x = R(2, S - 2), y = R(2, S - 2); px(ctx, x, y - 2, 1, 3, "#35702f"); px(ctx, x + 1, y - 1, 1, 2, "#35702f"); }
      });
    } else if (pattern === "sand") {
      px(ctx, 0, 0, S, S, "#d9b77c");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 30; i++) px(ctx, R(0, S), R(0, S), 1, 1, rng() < 0.5 ? "#c4a05e" : "#e8cb8f");
        for (let i = 0; i < 5; i++) { const x = R(2, S - 3), y = R(2, S - 3); px(ctx, x, y, 2, 2, "#b8935a"); px(ctx, x, y, 1, 1, "#e8cb8f"); }
      });
    } else if (pattern === "brick") {
      px(ctx, 0, 0, S, S, "#5c6068"); // mortar bed
      const bh = 8, bw = 16;
      for (let row = 0; row < S / bh; row++) {
        const off = row % 2 ? bw / 2 : 0;
        for (let cx = 0; cx < S / bw; cx++) {
          const shade = 150 + ((rng() * 30) | 0);
          ctx.fillStyle = `rgb(${shade},${shade - 25},${shade - 30})`;
          // wrapped(): bricks crossing the tile edge continue on the other
          // side — without this the right edge shows cut bricks (no wrap)
          wrapped(ctx, S, () => {
            ctx.fillRect(cx * bw + off, row * bh + 1, bw - 2, bh - 2);
          });
        }
      }
    } else if (pattern === "stone") {
      px(ctx, 0, 0, S, S, "#7d8590");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 9; i++) {
          const x = R(2, S - 2), y = R(2, S - 2), n = 3 + ((rng() * 5) | 0);
          for (let k = 0; k < n; k++) px(ctx, x + R(-3, 3), y + R(-3, 3), 2, 2, "#666e78");
        }
        for (let i = 0; i < 20; i++) px(ctx, R(0, S), R(0, S), 1, 1, "#98a1ab");
      });
    } else if (pattern === "wood") {
      px(ctx, 0, 0, S, S, "#8a5a2e");
      for (let row = 0; row < S / 8; row++) {
        const y = row * 8, shade = 128 + ((rng() * 22) | 0);
        ctx.fillStyle = `rgb(${shade},${shade - 58 | 0},${shade - 96 | 0})`;
        ctx.fillRect(0, y + 1, S, 7);
        ctx.fillStyle = "#5e3c1e";
        ctx.fillRect(0, y, S, 1);                                   // plank gap (tiles: 8 | 32)
        const jx = (row * 13 + 4) % S;                             // staggered joint
        ctx.fillRect(jx, y + 1, 1, 7);
        wrapped(ctx, S, () => {
          for (let i = 0; i < 5; i++) px(ctx, R(0, S), y + 2 + R(0, 5), 3, 1, "#6e4522"); // grain
        });
      }
    } else if (pattern === "metal") {
      px(ctx, 0, 0, S, S, "#6b7280");
      for (let py = 0; py < S; py += 16) {
        for (let pxx = 0; pxx < S; pxx += 16) {
          ctx.fillStyle = "#4b5563";
          ctx.fillRect(pxx, py, 16, 1); ctx.fillRect(pxx, py, 1, 16);
          ctx.fillStyle = "#9aa3ad";
          ctx.fillRect(pxx + 1, py + 1, 14, 1);                     // top highlight
          wrapped(ctx, S, () => {
            for (const [rx, ry] of [[3, 3], [12, 3], [3, 12], [12, 12]]) {
              px(ctx, pxx + rx, py + ry, 2, 2, "#3f4750");
              px(ctx, pxx + rx, py + ry, 1, 1, "#9aa3ad");
            }
          });
        }
      }
    } else if (pattern === "water") {
      px(ctx, 0, 0, S, S, "#2b6cb0");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 7; i++) {                              // deep bands
          const y = R(0, S);
          for (let x = 0; x < S; x += 2) px(ctx, x, y + Math.sin(x / 4) * 1.5, 2, 2, "#1e4e8a");
        }
        for (let i = 0; i < 10; i++) {                             // shimmer dashes drift per frame
          const x = (R(0, S) + fr * 8) % S, y = R(0, S);
          px(ctx, x, y, 3, 1, "#7dd3fc"); px(ctx, x + 1, y - 1, 1, 1, "#e0f2fe");
        }
      });
    } else { // dungeon
      px(ctx, 0, 0, S, S, "#3b404d");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 4; i++) {
          let x = R(0, S), y = R(0, S);
          for (let k = 0; k < 8; k++) { px(ctx, x, y, 1, 1, "#22262f"); x += R(-3, 3); y += R(-3, 3); }
        }
        for (let i = 0; i < 14; i++) px(ctx, R(0, S), R(0, S), 1, 1, "#4c5364");
      });
    }

    const up = makeCanvas(size, size);
    const uctx = up.getContext("2d");
    uctx.imageSmoothingEnabled = false;
    uctx.drawImage(base, 0, 0, size, size);
    out.push(up);
  }
  return out;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function procUI(kind, count, seedNum) {
  const rng = mulberry32(seedNum);
  const hue = (rng() * 360) | 0;
  const small = ["icon", "coin", "gem", "heart", "star"].includes(kind);
  const W = kind === "panel" ? 176 : kind === "health" ? 160 : small ? 64 : 132;
  const H = kind === "panel" ? 128 : kind === "health" ? 48 : small ? 64 : 48;
  const strip = makeCanvas(W * count, H);

  for (let v = 0; v < count; v++) {
    const ctx = strip.getContext("2d");
    ctx.save();
    ctx.translate(v * W, 0);
    const lift = v === 1 ? 8 : v === 2 ? -10 : 0;   // hover lighter, pressed darker
    const dy = v === 2 ? 2 : 0;

    if (kind === "button") {
      const base = `hsl(${hue},55%,${50 + lift}%)`, dark = `hsl(${hue},60%,${30 + lift}%)`;
      ctx.save(); ctx.translate(0, dy);
      rr(ctx, 2, 2, W - 4, H - 4, 12);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `hsl(${hue},60%,${62 + lift}%)`); g.addColorStop(1, base);
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = dark; ctx.stroke();
      rr(ctx, 8, 7, W - 16, 8, 4); ctx.fillStyle = "rgba(255,255,255,.28)"; ctx.fill();
      // glyph: chevron
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 5; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(W / 2 - 12, H / 2 - 7); ctx.lineTo(W / 2 + 2, H / 2); ctx.lineTo(W / 2 - 12, H / 2 + 7); ctx.stroke();
      ctx.restore();
    } else if (kind === "icon") {
      const pick = (seedNum + v) % 4;
      ctx.translate(0, dy);
      rr(ctx, 2, 2, W - 4, H - 4, 14);
      ctx.fillStyle = `hsl(${hue},40%,${22 + lift}%)`; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = `hsl(${hue},70%,${55 + lift}%)`; ctx.stroke();
      ctx.fillStyle = `hsl(${hue},75%,${62 + lift}%)`;
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 5; ctx.lineCap = "round";
      const c = W / 2;
      if (pick === 0) {          // sword
        ctx.beginPath(); ctx.moveTo(c - 12, c + 12); ctx.lineTo(c + 10, c - 10); ctx.stroke();
        ctx.fillRect(c - 14, c + 6, 16, 5); ctx.fillRect(c - 4, c + 8, 5, 12);
      } else if (pick === 1) {   // shield
        ctx.beginPath(); ctx.moveTo(c, c - 16); ctx.lineTo(c + 13, c - 8); ctx.lineTo(c + 13, c + 6);
        ctx.lineTo(c, c + 16); ctx.lineTo(c - 13, c + 6); ctx.lineTo(c - 13, c - 8); ctx.closePath(); ctx.fill();
      } else if (pick === 2) {   // star
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 7 : 16;
          ctx[i ? "lineTo" : "moveTo"](c + Math.cos(a) * r, c + Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill();
      } else {                   // potion
        ctx.fillRect(c - 4, c - 16, 8, 8);
        ctx.beginPath(); ctx.moveTo(c - 11, c + 14); ctx.lineTo(c - 6, c - 8); ctx.lineTo(c + 6, c - 8); ctx.lineTo(c + 11, c + 14); ctx.closePath(); ctx.fill();
      }
    } else if (kind === "coin") {
      // spin illusion: horizontal squash oscillates 1 -> 0 -> 1
      const t = count === 1 ? 0 : v / (count - 1);
      const squash = Math.abs(Math.cos(t * Math.PI));
      const rx = 4 + 20 * squash, ry = 24, c = W / 2;
      ctx.beginPath(); ctx.ellipse(c, H / 2, rx, ry, 0, 0, 7);
      ctx.fillStyle = "#f5c542"; ctx.fill();
      ctx.beginPath(); ctx.ellipse(c, H / 2, rx * 0.66, ry * 0.66, 0, 0, 7);
      ctx.fillStyle = "#d99a26"; ctx.fill();
      if (squash > 0.4) { ctx.fillStyle = "#ffe9a8"; ctx.fillRect(c - rx * 0.4, H / 2 - 14, 5, 10); }
    } else if (kind === "gem") {
      const c = W / 2, cy = H / 2;
      ctx.beginPath();
      ctx.moveTo(c - 18, cy - 6); ctx.lineTo(c - 8, cy - 16); ctx.lineTo(c + 8, cy - 16);
      ctx.lineTo(c + 18, cy - 6); ctx.lineTo(c, cy + 16); ctx.closePath();
      ctx.fillStyle = `hsl(${hue},80%,${55 + lift}%)`; ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,.4)";
      ctx.beginPath(); ctx.moveTo(c - 18, cy - 6); ctx.lineTo(c + 18, cy - 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c, cy - 16); ctx.lineTo(c, cy + 16); ctx.stroke();
      if (v % 2 === 0) { ctx.fillStyle = "#ffffff"; ctx.fillRect(c + 8, cy - 14, 6, 2); ctx.fillRect(c + 10, cy - 16, 2, 6); }
    } else if (kind === "heart") {
      const beat = 1 + (v % 2) * 0.14;
      const c = W / 2, cy = H / 2 + 2, r = 11 * beat;
      ctx.fillStyle = v === 2 ? "#b91c1c" : "#e53e3e";
      ctx.beginPath(); ctx.arc(c - r * 0.72, cy - r * 0.35, r * 0.78, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(c + r * 0.72, cy - r * 0.35, r * 0.78, 0, 7); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(c - r * 1.35, cy); ctx.lineTo(c + r * 1.35, cy); ctx.lineTo(c, cy + r * 1.5);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.beginPath(); ctx.arc(c - r * 0.72, cy - r * 0.5, r * 0.22, 0, 7); ctx.fill();
    } else if (kind === "star") {
      const c = W / 2, cy = H / 2, lit = v % 2 === 0;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? 8 : 19;
        ctx[i ? "lineTo" : "moveTo"](c + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.fillStyle = lit ? "#ffd23f" : "#d9a821"; ctx.fill();
      ctx.strokeStyle = "#8a5a00"; ctx.lineWidth = 2; ctx.stroke();
      if (lit) { ctx.fillStyle = "#ffffff"; ctx.fillRect(c + 8, cy - 14, 5, 2); ctx.fillRect(c + 10, cy - 16, 2, 5); }
    } else if (kind === "health") {
      // variants drain the bar: full -> low, green -> red
      const frac = count === 1 ? 1 : 1 - (v / (count - 1)) * 0.9;
      const bx = 6, by = 12, bw = W - 12, bh = H - 24;
      rr(ctx, bx, by, bw, bh, 8);
      ctx.fillStyle = "#1a1a1a"; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = "#444"; ctx.stroke();
      const fw = Math.max(6, (bw - 8) * frac);
      rr(ctx, bx + 4, by + 4, fw, bh - 8, 5);
      ctx.fillStyle = frac > 0.55 ? "#4ade80" : frac > 0.28 ? "#facc15" : "#ef4444";
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,.35)";
      for (let sxi = 1; sxi < 5; sxi++) ctx.fillRect(bx + (bw * sxi) / 5, by + 4, 2, bh - 8);
    } else { // panel
      ctx.translate(0, dy);
      rr(ctx, 2, 2, W - 4, H - 4, 16);
      ctx.fillStyle = `hsl(${hue},30%,${20 + lift}%)`; ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = `hsl(${hue},60%,${48 + lift}%)`; ctx.stroke();
      rr(ctx, 12, 12, W - 24, H - 24, 10);
      ctx.fillStyle = `hsl(${hue},25%,${14 + lift}%)`; ctx.fill();
      ctx.fillStyle = `hsl(${hue},70%,60%)`;
      for (const [rx, ry] of [[10, 10], [W - 10, 10], [10, H - 10], [W - 10, H - 10]]) {
        ctx.beginPath(); ctx.arc(rx, ry, 3, 0, 7); ctx.fill();
      }
    }
    ctx.restore();
  }
  return strip;
}

function procEffect(type, frames, seedNum) {
  const rng = mulberry32(seedNum);
  const S = 56;
  const strip = makeCanvas(S * frames, S);
  const cx = S / 2, cy = S / 2;

  for (let f = 0; f < frames; f++) {
    const ctx = strip.getContext("2d");
    ctx.save(); ctx.translate(f * S, 0);
    const t = frames === 1 ? 0 : f / (frames - 1);

    if (type === "explosion") {
      for (let i = 0; i < 42; i++) {
        const a = rng() * Math.PI * 2, sp = 0.35 + rng() * 0.75;
        const x = cx + Math.cos(a) * sp * t * 26, y = cy + Math.sin(a) * sp * t * 26;
        const sz = Math.max(1, (1 - t) * 5 * (0.5 + rng() * 0.5));
        ctx.fillStyle = t < 0.2 ? "#ffffff" : t < 0.45 ? "#ffd23f" : t < 0.7 ? "#ff7b1c" : t < 0.88 ? "#b3402a" : "#5c5c5c";
        ctx.globalAlpha = 1 - t * 0.55;
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
      const core = Math.max(1, (1 - t) * 14);
      ctx.fillStyle = "#fff3c4"; ctx.fillRect(cx - core / 2, cy - core / 2, core, core);
    } else if (type === "particles") {
      for (let i = 0; i < 26; i++) {
        const a = rng() * Math.PI * 2, sp = 0.4 + rng() * 0.8;
        const x = cx + Math.cos(a) * sp * t * 24, y = cy + Math.sin(a) * sp * t * 20 + t * t * 22;
        ctx.fillStyle = `hsl(${(rng() * 360) | 0},85%,60%)`;
        ctx.globalAlpha = 1 - t * 0.7;
        const sz = 2 + rng() * 3;
        ctx.fillRect(x, y, sz, sz);
      }
      ctx.globalAlpha = 1;
    } else if (type === "power-up") {
      for (let k = 0; k < 3; k++) {
        const r = 4 + t * 22 - k * 8;
        if (r <= 0) continue;
        ctx.strokeStyle = "#b8f53d";
        ctx.globalAlpha = (0.25 + 0.75 * (1 - t)) * (1 - k / 3);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 0.25 + 0.75 * Math.sin(t * Math.PI);
      ctx.fillStyle = "#ffffff";
      for (let i = 0; i < 5; i++) {
        const x = cx + (rng() - 0.5) * 36, y = cy + (rng() - 0.5) * 36;
        ctx.fillRect(x - 3, y - 1, 7, 2); ctx.fillRect(x - 1, y - 3, 2, 7);
      }
      ctx.globalAlpha = 1;
    } else if (type === "smoke") {
      for (let i = 0; i < 16; i++) {
        const life = (t + i / 16) % 1;                       // staggered puffs
        const y = cy + 18 - life * 40;
        const x = cx + Math.sin(life * 5 + i) * 8 + (rng() - 0.5) * 10;
        const sz = 4 + life * 12;
        ctx.fillStyle = "#9aa0a8";
        ctx.globalAlpha = 0.5 * (1 - life);
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
    } else if (type === "sparkle") {
      for (let i = 0; i < 14; i++) {
        const phz = (t * 2 + i * 0.37) % 1;
        const sz = Math.max(0, Math.sin(phz * Math.PI)) * 7;
        if (sz < 0.8) continue;
        const x = cx + (rng() - 0.5) * 44, y = cy + (rng() - 0.5) * 44;
        ctx.fillStyle = ["#ffffff", "#fef08a", "#bae6fd"][(rng() * 3) | 0];
        ctx.globalAlpha = 0.95;
        ctx.fillRect(x - sz / 2, y - 1, sz, 2);
        ctx.fillRect(x - 1, y - sz / 2, 2, sz);
      }
      ctx.globalAlpha = 1;
    } else if (type === "fire") {
      for (let i = 0; i < 26; i++) {
        const fx = cx + (rng() - 0.5) * 30;
        const maxH = 30 * (1 - Math.abs(fx - cx) / 22);
        const flick = 0.75 + 0.25 * Math.sin(t * 9 + i * 2.3);
        const hgt = Math.max(2, maxH * flick);
        const yTop = cy + 20 - hgt;
        const heat = hgt / 32;
        ctx.fillStyle = heat < 0.35 ? "#fff7cc" : heat < 0.6 ? "#ffd23f" : heat < 0.85 ? "#ff7b1c" : "#d63c1e";
        ctx.fillRect(fx - 2, yTop, 4, hgt);
      }
      for (let i = 0; i < 6; i++) {                          // rising embers
        const ey = cy + 18 - (((t * 1.4 + i / 6) % 1) * 44);
        ctx.fillStyle = "#ffb020";
        ctx.fillRect(cx + (rng() - 0.5) * 26, ey, 2, 2);
      }
    } else if (type === "ring") {
      for (let k = 0; k < 2; k++) {
        const rt = (t + k * 0.5) % 1;
        ctx.strokeStyle = k ? "#c084fc" : "#7df9ff";
        ctx.globalAlpha = 0.9 * (1 - rt);
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, 4 + rt * 24, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = Math.max(0, 1 - t * 3);              // core flash
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(cx - 3, cy - 3, 6, 6);
      ctx.globalAlpha = 1;
    } else if (type === "slash") {
      const ang = -70 + t * 140;                             // sweep across
      ctx.strokeStyle = "#e0f2fe"; ctx.lineWidth = 7; ctx.lineCap = "round";
      ctx.globalAlpha = 0.95;
      ctx.beginPath(); ctx.arc(cx, cy, 20, (ang - 28) * Math.PI / 180, (ang + 28) * Math.PI / 180); ctx.stroke();
      ctx.strokeStyle = "#7dd3fc"; ctx.lineWidth = 3;         // motion trail
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(cx, cy, 20, (ang - 60) * Math.PI / 180, (ang - 10) * Math.PI / 180); ctx.stroke();
      ctx.globalAlpha = 1;
    } else { // magic
      for (let i = 0; i < 30; i++) {
        const sway = Math.sin(t * 6 + i) * 5;
        const x = cx + (rng() - 0.5) * 34 + sway, y = cy + 20 - t * 40 - rng() * 8;
        ctx.fillStyle = ["#7df9ff", "#c084fc", "#ffffff"][(rng() * 3) | 0];
        ctx.globalAlpha = 0.9 - t * 0.5;
        const sz = 2 + rng() * 2;
        ctx.fillRect(x, y, sz, sz);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  return strip;
}

/* ================= pipeline runner ================= */

async function genTileAI(prompt, size) {
  const seed = (Math.random() * 1e9) | 0;
  const bmp = await fetchImageBitmap(pollinationsURL(prompt, 512, 512, seed), (n, total) => {
    if (n > 1) setStep("row", "active", `tile gen — retry ${n}/${total}…`);
  });
  const full = makeCanvas(bmp.width, bmp.height);
  full.getContext("2d").drawImage(bmp, 0, 0);
  const out = makeCanvas(size, size);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(full, 0, 0, size, size);
  return out;
}

function pushRow(name, frames, extra = {}) {
  const row = Object.assign(
    { name, frames, order: frames.map((_, i) => i), fps: 8, loop: true },
    extra
  );
  state.rows.push(row);
  state.originals.push(frames.slice());
}

async function runPipeline() {
  if (state.busy) return;
  setBusy(true);
  resetSteps();
  hideRetry();
  $("#promptPeek").hidden = true;
  enableExport(false);
  state.rows = []; state.originals = []; state.atlas = null;
  state.revision = Date.now().toString(36);
  renderFramesUI();
  $("#previewMeta").textContent = "";

  const cat = state.category, p = readParams();
  const seed = (Math.random() * 1e9) | 0;

  try {
    setStep("prompt", "active");
    stageMsg("building prompt…");

    if (cat === "character") {
      if (!p.states.length) fail("select at least one animation state.");
      for (const sname of p.states) {
        const prompt = buildPrompt(cat, p, sname, state.strict);
        showPromptPeek(prompt);
        stageMsg(`prompt [${sname}]: ${prompt}`);
        setStep("prompt", "done");
        setStep("row", "active", `row gen [${sname}] — one AI call, ${p.frames} poses on flat ${keyName()}…`);
        let strip;
        if (state.source === "ai") strip = await genRowAI(prompt, p.frames, 384, sname);
        else if (state.source === "procedural") strip = procCharacter(p, sname, seed);
        else strip = await uploadStrip(p.frames);
        showStage(strip, `row [${sname}]: raw ${strip.width}×${strip.height}`);
        setStep("row", "done");
        setStep("alpha", "active", "chroma key + despill (soft edges)…");
        const keyed = chromaKey(strip, state.key);
        showStage(keyed, `row [${sname}]: background keyed out`);
        setStep("alpha", "done");
        checkKeyCoverage(keyed);
        setStep("extract", "active", `extracting ${p.frames} poses (content-based)…`);
        const exC = extractFramesRobust(keyed, p.frames, { align: "bottom" });
        const slicedC = noteExtraction(exC, p.frames, "poses");
        pushRow(sname, exC.frames, { fps: STATE_FPS[sname] || 8, loop: true, slotSliced: slicedC });
        setStep("prompt", "active");
      }
    } else if (cat === "tile") {
      const prompt = buildPrompt(cat, p, undefined, state.strict);
      showPromptPeek(prompt);
      stageMsg("prompt: " + prompt);
      setStep("prompt", "done");
      setStep("row", "active", "generating tile…");
      let tileFrames;
      if (state.source === "ai") tileFrames = [await genTileAI(prompt, p.size)];
      else if (state.source === "procedural") tileFrames = procTile(p.pattern, p.size, seed);
      else tileFrames = [await uploadTile(p.size)];
      showStage(tileFrames[0], `tile: ${p.size}×${p.size}${tileFrames.length > 1 ? ` × ${tileFrames.length} frames (animated)` : ""}, edge-to-edge (no keying)`);
      setStep("row", "done"); setStep("alpha", "done"); setStep("extract", "done");
      pushRow("tile", tileFrames, { fps: tileFrames.length > 1 ? 4 : 0, loop: tileFrames.length > 1, tileable: true });
    } else if (cat === "ui") {
      const prompt = buildPrompt(cat, p, undefined, state.strict);
      showPromptPeek(prompt);
      stageMsg("prompt: " + prompt);
      setStep("prompt", "done");
      setStep("row", "active", `generating ${p.states} UI variant(s)…`);
      let strip;
      if (state.source === "ai") strip = await genRowAI(prompt, p.states, 256, p.kind);
      else if (state.source === "procedural") strip = procUI(p.kind, p.states, seed);
      else strip = await uploadStrip(p.states);
      showStage(strip, `UI row: raw ${strip.width}×${strip.height}`);
      setStep("row", "done");
      setStep("alpha", "active", "chroma key + despill…");
      const keyed = chromaKey(strip, state.key);
      showStage(keyed, "UI row: keyed");
      setStep("alpha", "done");
      checkKeyCoverage(keyed);
      setStep("extract", "active", `extracting ${p.states} variant(s)…`);
      const exU = extractFramesRobust(keyed, p.states, { align: "center" });
      const slicedU = noteExtraction(exU, p.states, "variants");
      pushRow(p.kind, exU.frames, { fps: 0, loop: false, slotSliced: slicedU });
    } else {
      const prompt = buildPrompt(cat, p, undefined, state.strict);
      showPromptPeek(prompt);
      stageMsg("prompt: " + prompt);
      setStep("prompt", "done");
      setStep("row", "active", `generating ${p.frames}-frame ${p.type}…`);
      let strip;
      if (state.source === "ai") strip = await genRowAI(prompt, p.frames, 384, p.type);
      else if (state.source === "procedural") strip = procEffect(p.type, p.frames, seed);
      else strip = await uploadStrip(p.frames);
      showStage(strip, `effect row: raw ${strip.width}×${strip.height}`);
      setStep("row", "done");
      setStep("alpha", "active", "chroma key + despill…");
      const keyed = chromaKey(strip, state.key);
      showStage(keyed, "effect row: keyed");
      setStep("alpha", "done");
      checkKeyCoverage(keyed);
      setStep("extract", "active", `extracting ${p.frames} frames…`);
      const exE = extractFramesRobust(keyed, p.frames, { align: "center" });
      const slicedE = noteExtraction(exE, p.frames, "frames");
      pushRow(p.type, exE.frames, { fps: 12, loop: true, slotSliced: slicedE });
    }

    setStep("atlas", "active", "packing rows → sprite sheet + manifest…");
    state.atlas = buildAtlas(state.rows);
    showStage(state.atlas.canvas, `atlas ${state.atlas.canvas.width}×${state.atlas.canvas.height} — one row per state, absolute rects in manifest`);
    setStep("atlas", "done");
    setStep("done", "done", `done — ${state.rows.length} row(s), rev ${state.revision}. originals untouched; ◀ ▶ only rewrites manifest order.`);

    renderFramesUI();
    startPreview();
    enableExport(true);
  } catch (e) {
    const active = document.querySelector("#stepper li.active");
    if (active) { active.classList.remove("active"); active.classList.add("error"); }
    if (/AI_RATE_LIMITED/.test(e.message)) {
      // honest, actionable, no stale pixels: clear the stage, amber message,
      // keep both recovery buttons (strict retry + one-click procedural)
      clearStage();
      const msg = e.message.replace(/^AI_RATE_LIMITED:\s*/, "");
      setStep("row", "warn");
      stageMsg(msg, "warn");
      showRetry(msg);
    } else {
      stageMsg("FAILED: " + e.message, true);
      showRetry("Extraction found nothing usable. Retry with a stricter prompt, lower the frame count, or pick a different background key.");
    }
  } finally {
    setBusy(false);
  }
}

/* upload source: provider-agnostic — any image in, frames out */
let uploadImg = null;
async function uploadStrip(count) {
  if (!uploadImg) fail("upload source selected but no image chosen — pick a file first.");
  return uploadImg;
}
async function uploadTile(size) {
  if (!uploadImg) fail("upload source selected but no image chosen — pick a file first.");
  const out = makeCanvas(size, size);
  const c = out.getContext("2d");
  c.imageSmoothingEnabled = false;
  c.drawImage(uploadImg, 0, 0, size, size);
  return out;
}

/* ================= wiring ================= */

function init() {
  renderParams();
  wireExport();

  document.querySelectorAll(".tab").forEach(t => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      state.category = t.dataset.cat;
      renderParams();
    };
  });

  document.querySelectorAll("#sourceSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#sourceSeg .seg-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.source = b.dataset.src;
      if (state.source === "upload") $("#uploadInput").click();
    };
  });

  $("#uploadInput").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const bmp = await createImageBitmap(f);
    uploadImg = makeCanvas(bmp.width, bmp.height);
    uploadImg.getContext("2d").drawImage(bmp, 0, 0);
    stageMsg(`uploaded ${bmp.width}×${bmp.height} — will key + extract on generate`);
    showStage(uploadImg, "upload ready");
  };

  document.querySelectorAll("#keyRow .key").forEach(k => {
    k.onclick = () => {
      document.querySelectorAll("#keyRow .key").forEach(x => x.classList.remove("active"));
      k.classList.add("active");
      const [r, g, b] = k.dataset.key.split(",").map(Number);
      state.key = { r, g, b };
    };
  });

  const startFresh = () => { state.strict = false; hideRetry(); runPipeline(); };
  $("#generate").onclick = startFresh;
  $("#generateMobile").onclick = startFresh;
  $("#retryBtn").onclick = () => { state.strict = true; hideRetry(); runPipeline(); };
  $("#procBtn").onclick = () => {
    // one-click escape hatch: drop to the offline generator and re-run
    state.source = "procedural";
    document.querySelectorAll("#sourceSeg .seg-btn").forEach(x => x.classList.toggle("active", x.dataset.src === "procedural"));
    state.strict = false;
    hideRetry();
    runPipeline();
  };
}

document.addEventListener("DOMContentLoaded", init);

/* ============ v3 "alive": themes + aura (Customize, tracker's spirit) ============
 * Isolated IIFE: theme switcher (6 swatches, data-theme + CSS vars, live, no
 * reload, localStorage) + animated background aura (toggle + intensity).
 * Doesn't touch the generation pipeline. */
(function () {
  "use strict";
  var THEMES = [
    { id: "violet",    name: "Violet dusk", swatch: "#8b5cf6" },
    { id: "midnight",  name: "Midnight",    swatch: "#0c66e4" },
    { id: "ocean",     name: "Ocean",       swatch: "#0ea5e9" },
    { id: "ember",     name: "Ember",       swatch: "#f97316" },
    { id: "forest",    name: "Forest",      swatch: "#22c55e" },
    { id: "porcelain", name: "Porcelain",   swatch: "#e2e8f0" },
  ];
  var LS_THEME = "msg_theme_v1", LS_AURA = "msg_aura_v1";

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function themeById(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return THEMES[0];
  }

  function applyTheme(id, save) {
    var t = themeById(id);
    document.documentElement.setAttribute("data-theme", t.id);
    if (save !== false) lsSet(LS_THEME, t.id);
    document.querySelectorAll("#swatches .swatch").forEach(function (b) {
      var on = b.dataset.theme === t.id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var nm = document.getElementById("swatchName");
    if (nm) nm.textContent = t.name;
  }

  function readAura() {
    var d = { enabled: true, intensity: 70 };
    try {
      var raw = lsGet(LS_AURA);
      if (raw) {
        var p = JSON.parse(raw);
        if (typeof p.enabled === "boolean") d.enabled = p.enabled;
        if (isFinite(p.intensity)) d.intensity = Math.min(100, Math.max(10, +p.intensity));
      }
    } catch (e) {}
    return d;
  }
  function applyAura() {
    var a = readAura();
    var el = document.getElementById("aura");
    if (el) el.classList.toggle("off", !a.enabled);
    document.documentElement.style.setProperty("--aura-intensity", (a.intensity / 100).toFixed(2));
    var tg = document.getElementById("auraToggle");
    if (tg) tg.setAttribute("aria-checked", a.enabled ? "true" : "false");
    var rg = document.getElementById("auraIntensity");
    if (rg) rg.value = String(a.intensity);
  }
  function saveAura(patch) {
    var a = readAura();
    for (var k in patch) a[k] = patch[k];
    lsSet(LS_AURA, JSON.stringify(a));
    applyAura();
  }

  function initCustomize() {
    var btn = document.getElementById("customizeBtn");
    var pop = document.getElementById("customizePop");
    if (!btn || !pop) return;

    var wrap = document.getElementById("swatches");
    THEMES.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "swatch";
      b.type = "button";
      b.dataset.theme = t.id;
      b.title = t.name;
      b.setAttribute("aria-label", "Theme: " + t.name);
      b.style.setProperty("--sw", t.swatch);
      b.onclick = function () { applyTheme(t.id); };
      wrap.appendChild(b);
    });
    var nm = document.createElement("div");
    nm.className = "swatch-name";
    nm.id = "swatchName";
    wrap.appendChild(nm);

    var open = false;
    var setOpen = function (v) {
      open = v;
      pop.hidden = !v;
      btn.setAttribute("aria-expanded", v ? "true" : "false");
    };
    btn.addEventListener("click", function (e) { e.stopPropagation(); setOpen(!open); });
    document.addEventListener("click", function (e) {
      if (open && !pop.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (open && e.key === "Escape") setOpen(false);
    });

    document.getElementById("auraToggle").addEventListener("click", function () {
      saveAura({ enabled: !readAura().enabled });
    });
    document.getElementById("auraIntensity").addEventListener("input", function (e) {
      saveAura({ intensity: +e.target.value });
    });

    applyTheme(lsGet(LS_THEME) || "violet", false);
    applyAura();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCustomize);
  } else {
    initCustomize();
  }
})();
