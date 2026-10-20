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
  source: "ai",            // ai | procedural
  aiModel: "pol-sana",     // provider id from the model switcher (AI_PROVIDERS)
  aiStyle: "still",        // character AI: "still" (one drawing, animated in-house) | "strip"
  charStash: null,         // user's character-panel picks (states/frames/style…), kept across re-renders
  key: { r: 255, g: 0, b: 255 },
  rows: [],                // [{ name, frames:[canvas], order:[idx], fps, loop }]
  originals: [],           // untouched extracted frames, parallel to rows
  revision: null,          // run-revision stamp; curation (order) is tied to it
  atlas: null,             // { canvas, manifest, pngName, jsonName }
  busy: false,
  strict: false,           // retry mode: appends the strict isolation clause to prompts
  slicer: null,            // v6.6 dedicated slicer: { sheet, imgW, imgH, rows, cols, mode, bg, knockout, margin, pad, ox, oy, pieces:[{canvas,empty,rect}], selection:[], fps, playback }
  pixelart: null,          // v6.5 image→pixel-art: { src:{data,w,h}, imgW, imgH, w, h, colors, dither, scale, out }
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
  pixelart:  { w: 64, h: 64, colors: 16 },
  slicer:    { rows: 3, cols: 9, mode: "grid", bg: "black", knockout: true, margin: 0, pad: 0, ox: 0, oy: 0, fps: 8, playback: "loop" },
};

const STATE_FPS = { idle: 6, walk: 8, run: 10, jump: 8, attack: 10 };

function renderParams() {
  const cat = state.category;
  const box = $("#params");
  /* the user's own picks survive re-renders (tab hops, gallery opens) —
   * defaults only fill a panel the user hasn't touched yet */
  const d = (cat === "character" && state.charStash)
    ? { ...CATEGORY_DEFAULTS[cat], ...state.charStash }
    : CATEGORY_DEFAULTS[cat];

  if (cat === "character") {
    box.innerHTML = `
      <div class="field-label">Animation states <span class="dim" id="stateCostNote">(one AI call per state)</span></div><div class="row" id="stateRow">
        ${["idle", "walk", "run", "jump", "attack"].map(s =>
          `<label class="chk"><input type="checkbox" data-state="${s}" ${d.states.includes(s) ? "checked" : ""}>${s}</label>`).join("")}
      </div><div class="row"><span class="dim">frames/state</span><input type="number" class="num" id="pFrames" min="2" max="12" value="${d.frames}"><span class="dim">style</span><select id="pStyle" class="grow"><option value="flat 2D game sprite, absolutely no 3D, no 3D render, no volumetric lighting, solid flat colors, crisp edges">clean 2D</option><option value="retro pixel art, visible square pixels, limited 16-color palette, 16-bit game sprite, absolutely no 3D, no smooth 3D shading">pixel art</option><option value="2D cartoon, flat colors, bold outlines, hand-drawn animation cel style, absolutely no 3D">cartoon</option><option value="dark fantasy 2D game art, flat painterly 2D illustration, moody lighting, absolutely no 3D render">dark fantasy</option></select></div><div class="row"><span class="dim">view</span><select id="pView"><option value="side">side</option><option value="front">front</option></select><span class="dim">facing</span><div class="seg" id="pFlipSeg" style="grid-template-columns:repeat(2,minmax(0,1fr));flex:1"><button type="button" class="seg-btn${state.flipX ? "" : " active"}" data-flip="0" title="face right">&#8594; right</button><button type="button" class="seg-btn${state.flipX ? " active" : ""}" data-flip="1" title="face left">&#8592; left</button></div></div><div class="row"><span class="dim">archetype</span><select id="pArch" class="grow">
          ${[["biped", "biped"], ["quadruped", "quadruped"], ["flyer", "flyer / bird"], ["slime", "slime"], ["robot", "robot"], ["ghost", "ghost"]]
            .map(([v, lbl]) => `<option value="${v}" ${v === d.archetype ? "selected" : ""}>${lbl}</option>`).join("")}
        </select><span class="dim">palette</span><select id="pPal">
          ${["classic", "ember", "frost", "toxic", "royal", "shadow"].map(pl => `<option ${pl === d.palette ? "selected" : ""}>${pl}</option>`).join("")}
        </select><button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button></div>`;
  } else if (cat === "tile") {
    box.innerHTML = `
      <div class="field-label">Tile</div><div class="row"><span class="dim">size</span><select id="pSize">
          ${[32, 64, 128, 256].map(s => `<option value="${s}" ${s === d.size ? "selected" : ""}>${s}px</option>`).join("")}
        </select><span class="dim">procedural pattern</span><select id="pPattern" class="grow">
          ${TILE_PATTERNS.map(pat => `<option ${pat === d.pattern ? "selected" : ""}>${pat}</option>`).join("")}
        </select><button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button></div><div class="dim" style="margin-bottom:4px">Tiles export edge-to-edge (no keying) and preview in a 3&times;3 wrap.</div>`;
  } else if (cat === "ui") {
    box.innerHTML = `
      <div class="field-label">UI element</div><div class="row"><select id="pKind" class="grow">
          ${[["button", "button"], ["icon", "icon"], ["panel", "panel"], ["coin", "coin"], ["gem", "gem"], ["heart", "heart"], ["star", "star"], ["health", "health bar"]]
            .map(([v, lbl]) => `<option value="${v}" ${v === d.kind ? "selected" : ""}>${lbl}</option>`).join("")}
        </select><span class="dim">variants</span><input type="number" class="num" id="pStates" min="1" max="4" value="${d.states}"><button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button></div><div class="dim">Variants = normal / hover / pressed style states, extracted left to right.</div>`;
  } else if (cat === "pixelart") {
    const px = CATEGORY_DEFAULTS.pixelart;
    box.innerHTML = `
      <div class="field-label">Image &rarr; pixel art <span class="dim">(100% offline)</span></div><div class="row"><button type="button" class="btn-ghost" id="pxPick" style="text-align:center">Upload image</button><input type="file" id="pxFile" accept="image/*" hidden></div><div class="field-label">Output size</div><div class="px-dims" id="pxDims">
        ${[16, 32, 48, 64, 96, 128].map(s => `<button type="button" class="seg-btn${s === px.w ? " active" : ""}" data-px="${s}">${s}</button>`).join("")}
        <button type="button" class="seg-btn" id="pxOrigBtn" title="use the uploaded image's original dimensions">Original</button>
      </div><div class="row" style="margin-top:8px"><span class="dim">W</span><input type="number" class="num" id="pxW" min="8" max="1024" value="${px.w}"><span class="dim">H</span><input type="number" class="num" id="pxH" min="8" max="1024" value="${px.h}"></div><div class="field-label">Tile grid <span class="dim">(tilemap overlay)</span></div><div class="row"><label class="chk"><input type="checkbox" id="pxGrid"${px.grid ? " checked" : ""}> show grid</label><select id="pxTile" aria-label="tile size">${[8, 16, 24, 32, 48, 64].map(t => `<option value="${t}"${t === px.tile ? " selected" : ""}>${t}px tiles</option>`).join("")}</select><span class="dim" id="pxTileCount"></span></div><div class="field-label">Colors</div><div class="row"><select id="pxColors" class="grow">
          ${[[2, "2 colors"], [4, "4 colors"], [8, "8 colors"], [16, "16 colors"], [32, "32 colors"], [256, "256 colors"], [0, "Full color"]].map(([v, lbl]) => `<option value="${v}"${v === px.colors ? " selected" : ""}>${lbl}</option>`).join("")}
        </select></div><label class="chk"><input type="checkbox" id="pxDither"${px.dither ? " checked" : ""}> dithering <span class="dim">(Floyd&ndash;Steinberg)</span></label><div class="row" style="margin-top:8px"><span class="dim">preview</span><input type="range" id="pxScale" min="2" max="16" value="${px.scale}" class="grow" aria-label="preview scale"><span class="dim" id="pxScaleVal">&times;${px.scale}</span></div><button type="button" class="btn-ghost px-download" id="pxDownload">Download pixel art</button><div class="dim">Upload any image — it never leaves your browser.</div>`;
    wirePixelArt();
  } else if (cat === "slicer") {
    const sl = slState();
    box.innerHTML = `
      <div class="field-label">Sprite slicer <span class="dim">(100% offline)</span></div><div class="row"><button type="button" class="btn-ghost" id="slPick" style="text-align:center">Upload sheet</button><input type="file" id="slFile" accept="image/*" hidden></div><div class="field-label">Mode</div><div class="seg" id="slModeSeg"><button type="button" class="seg-btn${sl.mode === "grid" ? " active" : ""}" data-mode="grid">Grid</button><button type="button" class="seg-btn${sl.mode === "auto" ? " active" : ""}" data-mode="auto">Auto-detect</button></div><div id="slGridRow"${sl.mode === "grid" ? "" : " hidden"}><div class="sl-row"><span class="dim">rows</span><input type="range" id="slRows" min="1" max="32" value="${sl.rows}" aria-label="grid rows"><span class="sl-val" id="slRowsVal">${sl.rows}</span></div><div class="sl-row"><span class="dim">cols</span><input type="range" id="slCols" min="1" max="32" value="${sl.cols}" aria-label="grid columns"><span class="sl-val" id="slColsVal">${sl.cols}</span></div><div class="sl-grid4"><label>margin<input type="number" class="num" id="slMargin" min="0" max="200" value="${sl.margin}"></label><label>padding<input type="number" class="num" id="slPad" min="0" max="200" value="${sl.pad}"></label><label>offset x<input type="number" class="num" id="slOx" min="0" max="500" value="${sl.ox}"></label><label>offset y<input type="number" class="num" id="slOy" min="0" max="500" value="${sl.oy}"></label></div></div><div class="sl-readout" id="slReadout">upload a sheet to start</div><div class="field-label">Background <span class="dim">(treated as empty)</span></div><div class="seg cols4" id="slBgSeg">
        ${[["transparent", "Alpha"], ["black", "Black"], ["white", "White"], ["chroma", "Key"]].map(([v, lbl]) => `<button type="button" class="seg-btn${v === sl.bg ? " active" : ""}" data-bg="${v}">${lbl}</button>`).join("")}
      </div><label class="knock-row"><input type="checkbox" id="slKnockout"${sl.knockout ? " checked" : ""}> Knockout bg &rarr; transparent</label><div class="sl-pick-row"><button type="button" class="btn-ghost" id="slSelectAll">Select all</button><button type="button" class="btn-ghost" id="slClear">Clear</button><button type="button" class="btn-ghost" id="slReslice">Re-slice</button></div><div class="sl-hint">Click pieces in order &mdash; 1st = frame 1. Empty cells flagged.</div><div class="field-label">Playback</div><div class="row"><span class="dim">fps</span><select id="slFps">${[6, 8, 12, 24].map(f => `<option value="${f}"${f === sl.fps ? " selected" : ""}>${f} fps</option>`).join("")}</select></div><div class="seg" id="slPlaybackSeg" style="margin-top:8px">
        ${[["loop", "Loop"], ["once", "Once"], ["pingpong", "Ping-pong"]].map(([v, lbl]) => `<button type="button" class="seg-btn${v === sl.playback ? " active" : ""}" data-playback="${v}">${lbl}</button>`).join("")}
      </div><button type="button" class="btn-ghost sl-download" id="slDownload" disabled>Download animation <span class="dim">PNG + JSON</span></button><button type="button" class="btn-ghost sl-download" id="slCells" disabled>Download cells <span class="dim">individual PNGs</span></button><div class="dim">100% offline.</div>`;
    wireSlicer();
  } else {
    box.innerHTML = `
      <div class="field-label">Effect</div><div class="row"><select id="pType" class="grow">
          ${["explosion", "fire", "smoke", "sparkle", "ring", "slash", "particles", "power-up", "magic", "heal", "portal"]
            .map(t => `<option ${t === d.type ? "selected" : ""}>${t}</option>`).join("")}
        </select><span class="dim">frames</span><input type="number" class="num" id="pFrames" min="4" max="16" value="${d.frames}"><button type="button" class="mini-btn" id="pShuffle" title="re-roll variant (new random seed)">&#8635;</button></div>`;
  }

  const prompts = {
    character: "zombie pirate with a rusty hook hand",
    tile: "mossy dungeon floor stones",
    ui: "round fantasy RPG menu button, gold trim",
    effect: "fiery explosion with smoke",
    pixelart: "not used — upload an image instead",
    slicer: "not used — upload a sheet instead",
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
    if (res.status === 401) {
      // New endpoint needs the domain registered (enter.pollinations.ai) —
      // caller falls back to the legacy host instead of failing.
      throw new Error("POLLINATIONS_401_DOMAIN_NOT_REGISTERED");
    }
    if (!retryableStatus(res.status)) {
      fail(`image request failed (HTTP ${res.status}) — not retryable; try Procedural mode`);
    }
    // else: loop for another attempt
  }
  fail(`AI_RATE_LIMITED: Pollinations is rate-limiting free requests right now` +
    (lastStatus ? ` (HTTP ${lastStatus} after 3 tries)` : ` (network unreachable after 3 tries)`) +
    `. Wait a minute and retry, or use Procedural mode.`);
}

async function fetchImageBitmap(url, onAttempt, fallbackUrl) {
  try {
    const res = await fetchWithRetry(url, onAttempt);
    const blob = await res.blob();
    return createImageBitmap(blob);
  } catch (e) {
    // Domain not registered on the new endpoint → legacy host (Sana, weaker but free)
    if (fallbackUrl && e && /POLLINATIONS_401/.test(e.message)) {
      const res = await fetchWithRetry(fallbackUrl, onAttempt);
      const blob = await res.blob();
      return createImageBitmap(blob);
    }
    throw e;
  }
}

function pollinationsURL(prompt, w, h, seed) {
  // New unified endpoint: serves real FLUX/Z-Image (old host only serves Sana now).
  // Works keyless once the domain is registered at enter.pollinations.ai
  // (referer-based); falls back to the legacy host on 401.
  return "https://gen.pollinations.ai/image/" + encodeURIComponent(prompt) +
    `?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux`;
}
function pollinationsLegacyURL(prompt, w, h, seed) {
  return "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
    `?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux`;
}

/* ---------------- AI model switcher (v6.8) ----------------
 * Every provider honours one contract: prompt + size in, one image bitmap
 * out. Each entry declares what it needs up front — no key, a free key, or a
 * paid key — and a provider that can't run fails loudly with instructions
 * instead of quietly swapping in a weaker model behind the user's back.
 * Keys live only in this browser's localStorage; they are never uploaded
 * anywhere except the provider the user picked. */

const AI_PROVIDERS = {
  "pol-sana": {
    note: "Free, no key. Fast — good for quick drafts.",
    keyField: null
  },
  "horde-deliberate": {
    note: "Free, no key. Community GPUs — usually 20–60s, much better detail than Sana.",
    keyField: null, hordeModel: "Deliberate"
  },
  "horde-juggernaut": {
    note: "Free, no key. Best free quality — can sit in the queue 1–3 min.",
    keyField: null, hordeModel: "Juggernaut XL"
  },
  "horde-sd": {
    note: "Free, no key. The Horde's quickest model.",
    keyField: null, hordeModel: "stable_diffusion"
  },
  "pol-flux": {
    note: "Real FLUX quality.",
    keyField: "pollinations", keyLabel: "Pollinations key",
    keyHint: `Free key: sign in at <a href="https://enter.pollinations.ai" target="_blank" rel="noopener">enter.pollinations.ai</a>, create a key, paste it here. Saved only in your browser.`
  },
  "hf-flux": {
    note: "FLUX.1 schnell through Hugging Face — fast FLUX renders.",
    keyField: "huggingface", keyLabel: "Hugging Face token",
    keyHint: `Free token: <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">huggingface.co/settings/tokens</a> → New token (Read) → paste here. Saved only in your browser.`
  },
  "openrouter": {
    note: "Gemini Flash Image through OpenRouter. NOT free — roughly a cent per image, charged to your own OpenRouter key.",
    keyField: "openrouter", keyLabel: "OpenRouter key",
    keyHint: `Key: <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Saved only in your browser; images are billed to that key.`
  }
};

const LS_AI_MODEL = "m4ster.aiModel";
const LS_AI_KEYS = "m4ster.aiKeys";

function aiKeys() {
  try { return JSON.parse(localStorage.getItem(LS_AI_KEYS) || "{}"); }
  catch (e) { return {}; }
}
function aiKeyFor(providerId) {
  const p = AI_PROVIDERS[providerId];
  if (!p || !p.keyField) return "";
  return (aiKeys()[p.keyField] || "").trim();
}
function needKey(providerId) {
  const p = AI_PROVIDERS[providerId];
  const key = aiKeyFor(providerId);
  if (!key) {
    fail(`This model needs your ${p.keyLabel} — paste it under "AI model" first (it's free to get, see the hint there). Nothing was generated.`);
  }
  return key;
}

/* fit a requested size into a provider's box: sides are multiples of 64,
 * neither side above maxSide, total area near maxPixels */
function fitSize(w, h, maxSide, maxPixels) {
  let scale = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
  const r64 = n => Math.max(64, Math.round((n * scale) / 64) * 64);
  return { w: r64(w), h: r64(h) };
}

async function blobToBitmap(blob) { return createImageBitmap(blob); }

async function hordeGenerate(prompt, w, h, model, onStatus) {
  /* anonymous Horde jobs are capped at 512×512 worth of pixels total —
   * ask for more and the submit is refused outright (HTTP 403) */
  const size = fitSize(w, h, 1024, 512 * 512);
  const headers = {
    "Content-Type": "application/json",
    "apikey": "0000000000",
    "Client-Agent": "m4ster-framelab:6.8:web"
  };
  let jobId = null;
  try {
    const res = await fetch("https://stablehorde.net/api/v2/generate/async", {
      method: "POST", headers,
      body: JSON.stringify({
        prompt,
        params: {
          width: size.w, height: size.h, steps: 25,
          sampler_name: "k_euler_a", cfg_scale: 7,
          seed: String((Math.random() * 1e9) | 0),
          negative_prompt: "gradient, vignette, border, frame, backdrop, scenery, " +
            "splash shape, decorative background, floor, shadow, watermark, text, " +
            "3d render, photorealistic, blurry, multiple characters"
        },
        models: [model], nsfw: false, r2: false
      })
    });
    if (!res.ok) fail(`AI Horde rejected the job (HTTP ${res.status}). The free queue may be full — wait a bit and retry.`);
    jobId = (await res.json()).id;
  } catch (e) {
    if (e && /^AI Horde/.test(e.message)) throw e;
    fail("AI Horde is unreachable right now (network). Retry in a moment, or pick another model.");
  }
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    let chk;
    try {
      const r = await fetch(`https://stablehorde.net/api/v2/generate/check/${jobId}`, { headers });
      chk = await r.json();
    } catch (e) { continue; } // transient poll miss — keep waiting
    if (chk.faulted) fail("AI Horde dropped the job (a worker failed mid-render). Retry — the queue usually clears fast.");
    if (!chk.done) {
      if (onStatus) onStatus(`AI Horde · ${model} — queued, ~${Math.max(1, chk.wait_time | 0)}s left…`);
      continue;
    }
    const fin = await fetch(`https://stablehorde.net/api/v2/generate/status/${jobId}`, { headers });
    const data = await fin.json();
    const gen = data.generations && data.generations[0];
    if (!gen || !gen.img) fail("AI Horde finished but returned no image. Retry once — if it repeats, pick another model.");
    if (/^https?:/.test(gen.img)) {
      const imgRes = await fetch(gen.img, { mode: "cors" });
      return blobToBitmap(await imgRes.blob());
    }
    const bin = atob(gen.img);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return blobToBitmap(new Blob([bytes], { type: "image/webp" }));
  }
  fail("AI Horde took over 5 minutes in the free queue — timed out. Retry, or pick a faster model (Sana / Stable Diffusion).");
}

async function hfGenerate(prompt, w, h, token, onStatus) {
  const size = fitSize(w, h, 1024, 1024 * 1024);
  const url = "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell";
  const opts = {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: prompt, parameters: { width: size.w, height: size.h } })
  };
  let res = await fetch(url, opts);
  if (res.status === 503) {
    let wait = 15;
    try { const j = await res.json(); wait = Math.min(30, Math.ceil(j.estimated_time || 15)); } catch (e) {}
    if (onStatus) onStatus(`Hugging Face — model warming up, ~${wait}s…`);
    await sleep(wait * 1000);
    res = await fetch(url, opts);
  }
  if (res.status === 401 || res.status === 403) {
    fail("Hugging Face rejected that token. Check the token under \"AI model\" (needs Read access) and retry.");
  }
  if (!res.ok) fail(`Hugging Face image request failed (HTTP ${res.status}). Free tokens have tight rate limits — wait a minute and retry.`);
  return blobToBitmap(await res.blob());
}

async function polFluxGenerate(prompt, w, h, key, onStatus) {
  const seed = (Math.random() * 1e9) | 0;
  const url = "https://gen.pollinations.ai/image/" + encodeURIComponent(prompt) +
    `?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux&key=${encodeURIComponent(key)}`;
  let res;
  try { res = await fetch(url, { mode: "cors" }); }
  catch (e) { fail("Pollinations FLUX is unreachable right now (network). Retry in a moment."); }
  if (res.status === 401 || res.status === 403) {
    fail("Pollinations rejected that key. Check the key under \"AI model\" (from enter.pollinations.ai) and retry.");
  }
  if (!res.ok) fail(`Pollinations FLUX request failed (HTTP ${res.status}). Retry in a moment.`);
  return blobToBitmap(await res.blob());
}

async function openRouterGenerate(prompt, w, h, key, onStatus) {
  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://m4ster-framelab.vercel.app",
        "X-Title": "m4ster FrameLab"
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        modalities: ["image", "text"],
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch (e) { fail("OpenRouter is unreachable right now (network). Retry in a moment."); }
  if (res.status === 401 || res.status === 403) {
    fail("OpenRouter rejected that key. Check the key under \"AI model\" and retry.");
  }
  if (res.status === 402) {
    fail("OpenRouter says that key has no credit. Image models there are pay-per-image — add credit or pick a free model.");
  }
  if (!res.ok) fail(`OpenRouter request failed (HTTP ${res.status}). Retry in a moment.`);
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  const img = msg && msg.images && msg.images[0] && msg.images[0].image_url && msg.images[0].image_url.url;
  if (!img) fail("OpenRouter answered without an image. Retry once — if it repeats, pick another model.");
  const imgRes = await fetch(img);
  return blobToBitmap(await imgRes.blob());
}

/* the one door every AI image comes through */
async function aiGenerateImage(prompt, w, h, onStatus) {
  const id = AI_PROVIDERS[state.aiModel] ? state.aiModel : "pol-sana";
  const p = AI_PROVIDERS[id];
  if (id === "pol-sana") {
    const seed = (Math.random() * 1e9) | 0;
    return fetchImageBitmap(pollinationsLegacyURL(prompt, w, h, seed), (n, total) => {
      if (n > 1 && onStatus) onStatus(`Pollinations · Sana — retry ${n}/${total}…`);
    });
  }
  if (p.hordeModel) return hordeGenerate(prompt, w, h, p.hordeModel, onStatus);
  if (id === "pol-flux") return polFluxGenerate(prompt, w, h, needKey(id), onStatus);
  if (id === "hf-flux") return hfGenerate(prompt, w, h, needKey(id), onStatus);
  if (id === "openrouter") return openRouterGenerate(prompt, w, h, needKey(id), onStatus);
  fail("Unknown AI model selected — pick one from the list.");
}

/* switcher UI: visibility, key row, notes — driven by the provider table */
function syncAiModelUI() {
  const sel = document.getElementById("aiModel");
  const box = document.getElementById("aiModelBox");
  if (!sel || !box) return;
  box.hidden = state.source !== "ai";
  sel.value = AI_PROVIDERS[state.aiModel] ? state.aiModel : "pol-sana";
  const p = AI_PROVIDERS[sel.value];
  const keyRow = document.getElementById("aiKeyRow");
  const keyInput = document.getElementById("aiKey");
  const hint = document.getElementById("aiKeyHint");
  const note = document.getElementById("aiModelNote");
  if (p.keyField) {
    keyRow.hidden = false;
    keyInput.placeholder = `paste your ${p.keyLabel}`;
    keyInput.value = aiKeys()[p.keyField] || "";
    hint.innerHTML = p.keyHint;
  } else {
    keyRow.hidden = true;
  }
  note.textContent = p.note || "";
  const styleRow = document.getElementById("aiStyleRow");
  if (styleRow) {
    styleRow.hidden = !(state.source === "ai" && state.category === "character");
    styleRow.querySelectorAll(".seg-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.style === state.aiStyle));
  }
  const costNote = document.getElementById("stateCostNote");
  if (costNote) {
    costNote.textContent = state.source === "ai" && state.aiStyle === "still"
      ? "(one AI call total — states animated in-house)"
      : "(one AI call per state)";
  }
  const genNote = document.querySelector(".gen-note");
  if (genNote) {
    genNote.textContent = state.source === "ai"
      ? "AI source: model picked above. Procedural runs 100% offline."
      : "Procedural runs 100% offline — no network at all.";
  }
}

async function genRowAI(prompt, frames, cellH, label) {
  // Wide strip: one cell per frame. Keep the strip >=1024px wide so frames
  // carry usable detail (the model returns blurry mush at small sizes).
  const h = cellH || 384;
  const w = Math.min(2048, Math.max(1024, h * frames));
  const bmp = await aiGenerateImage(prompt, w, h, (msg) => {
    setStep("row", "active", `row gen [${label}] — ${msg}`);
  });
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  return c;
}

/* sample the background colour that is actually there (corners average).
 * Models drift from the textbook key colour — magenta comes back dusty
 * pink, grey-blue, cream — so keying anchors to the sampled colour. */
function sampleKeyColor(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const s = Math.max(2, Math.min(12, (Math.min(w, h) / 20) | 0));
  const pts = [[0, 0], [w - s, 0], [0, h - s], [w - s, h - s]];
  let r = 0, g = 0, b = 0, n = 0;
  for (const [x, y] of pts) {
    const d = ctx.getImageData(x, y, s, s).data;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/* flood keying for AI stills: region-grow from every border pixel. A pixel
 * joins the background only if BOTH hold: it is close to the background
 * pixel it grew from (small per-step step — this eats gradients and
 * vignettes), AND it is still within a capped total distance of the
 * sampled background colour. The cap is what stops the flood leaking
 * through a soft painterly edge and eating the whole character — with
 * chain-similarity alone, a washed-out render loses everything but its
 * outlines. The cap adapts: it is loosened by how far the background
 * colour itself drifts between the image corners (a flat backdrop keeps
 * the cap tight; a vignette earns headroom). */
function floodKey(src, tol = 12) {
  const w = src.width, h = src.height;
  const ctx = src.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const bgc = sampleKeyColor(src);
  const cornerCols = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  });
  let spread = 0;
  for (const a of cornerCols) for (const b of cornerCols) {
    spread = Math.max(spread, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]));
  }
  const cap = spread + 190;
  const withinCap = i => {
    const a = i * 4;
    return Math.abs(d[a] - bgc.r) + Math.abs(d[a + 1] - bgc.g) + Math.abs(d[a + 2] - bgc.b) <= cap;
  };
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = i => { if (!bg[i] && withinCap(i)) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  const near = (i, j) => {
    const a = i * 4, b = j * 4;
    return Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]) <= tol;
  };
  while (stack.length) {
    const cur = stack.pop();
    const cx = cur % w, cy = (cur / w) | 0;
    if (cx > 0)     { const n = cur - 1; if (!bg[n] && near(cur, n)) push(n); }
    if (cx < w - 1) { const n = cur + 1; if (!bg[n] && near(cur, n)) push(n); }
    if (cy > 0)     { const n = cur - w; if (!bg[n] && near(cur, n)) push(n); }
    if (cy < h - 1) { const n = cur + w; if (!bg[n] && near(cur, n)) push(n); }
  }
  for (let i = 0; i < w * h; i++) if (bg[i]) d[i * 4 + 3] = 0;
  const out = makeCanvas(w, h);
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}

/* keep only the largest connected blob of a keyed still, clear the rest.
 * Models ignore "one character" often enough (mini sprite sheets, stray
 * marks, the Pollinations watermark in a corner) — extraction merges their
 * bounding boxes into the cell, so without this pass the junk rides along
 * inside every frame. */
function keepLargestBlob(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const label = new Int32Array(w * h).fill(-1);
  let best = -1, bestSize = 0, next = 0;
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || d[start * 4 + 3] <= 12) continue;
    let size = 0;
    label[start] = next;
    stack.push(start);
    while (stack.length) {
      const cur = stack.pop();
      size++;
      const cx = cur % w, cy = (cur / w) | 0;
      if (cx > 0)     { const n = cur - 1; if (label[n] === -1 && d[n * 4 + 3] > 12) { label[n] = next; stack.push(n); } }
      if (cx < w - 1) { const n = cur + 1; if (label[n] === -1 && d[n * 4 + 3] > 12) { label[n] = next; stack.push(n); } }
      if (cy > 0)     { const n = cur - w; if (label[n] === -1 && d[n * 4 + 3] > 12) { label[n] = next; stack.push(n); } }
      if (cy < h - 1) { const n = cur + w; if (label[n] === -1 && d[n * 4 + 3] > 12) { label[n] = next; stack.push(n); } }
    }
    if (size > bestSize) { bestSize = size; best = next; }
    next++;
  }
  if (best < 0) return canvas;
  for (let i = 0; i < w * h; i++) if (label[i] !== best) d[i * 4 + 3] = 0;
  const out = makeCanvas(w, h);
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}

/* fraction of pixels keying cleared (sampled). Near zero = the backdrop
 * is still fully attached and the "sprite" would be a bobbing rectangle */
function clearedFrac(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let clear = 0, n = 0;
  for (let i = 3; i < d.length; i += 16) { n++; if (d[i] <= 12) clear++; }
  return n ? clear / n : 0;
}

/* did keying eat the subject? the middle of the frame should still hold a
 * solid share of opaque pixels — a standing character lives there */
function hollowCenter(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const x0 = (w * 0.3) | 0, x1 = (w * 0.7) | 0, y0 = (h * 0.25) | 0, y1 = (h * 0.8) | 0;
  let opaque = 0, total = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    total++;
    if (d[(y * w + x) * 4 + 3] > 12) opaque++;
  }
  return total === 0 || opaque / total < 0.03;
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
      drawFrameAt(sctx, f, x, y);
      rects.push({ x, y, w: cw, h: ch });
    });
    frameLayout.rows[r.name] = { row: ri, cellWidth: cw, cellHeight: ch, rects };
    const fps = r.fps || 8;
    animations[r.name] = {
      row: ri,
      frames: r.order.length,
      fps,
      loop: r.loop !== false,
      facing: state.flipX ? "left" : "right",
      durationsMs: r.order.map(() => Math.round(1000 / fps)),
      frameOrder: r.order.slice(),
      slotSliced: !!r.slotSliced, // true when blob recovery failed and even slots were cut
    };
    y += ch + pad;
  });

  const manifest = {
    tool: BRAND.tool,
    version: "2.2.0",
    engine: "component-row",
    runRevision: state.revision,
    atlas: "m4ster-sprite-sheet.png",
    sheetWidth: sheetW,
    sheetHeight: sheetH,
    frameLayout,
    animations,
    curation: curation(),
  };

  return { canvas: sheet, manifest, pngName: "m4ster-sprite-sheet.png", jsonName: "m4ster-sprite-atlas.json" };
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
      const fc = cv.getContext("2d");
      if (state.flipX) { fc.translate(cv.width, 0); fc.scale(-1, 1); }
      fc.drawImage(r.frames[fi], 0, 0);
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
  cancelAnimationFrame(slicerRAF);
  const sel = $("#previewState");
  sel.innerHTML = "";
  sel.disabled = false;
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
      pctx.save();
      if (state.flipX) { pctx.translate(pc.width, 0); pctx.scale(-1, 1); }
      pctx.drawImage(f, (pc.width - dw) / 2, (pc.height - dh) / 2, dw, dh);
      pctx.restore();
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
  $("#dlSheet").onclick = () => state.atlas && downloadCanvas(state.atlas.canvas, state.atlas.pngName || "m4ster-sprite-sheet.png");
  $("#dlJson").onclick = () => state.atlas && downloadJSON(state.atlas.manifest, state.atlas.jsonName || "m4ster-sprite-atlas.json");
  $("#dlAnim").onclick = () => {
    // one button, both files: the picked animation as sheet PNG + manifest JSON
    if (!state.atlas) return;
    downloadCanvas(state.atlas.canvas, state.atlas.pngName || "m4ster-sprite-sheet.png");
    setTimeout(() => downloadJSON(state.atlas.manifest, state.atlas.jsonName || "m4ster-sprite-atlas.json"), 400);
  };
  const godotBtn = $("#dlGodot");
  if (godotBtn) godotBtn.onclick = () => { downloadGodotPack().catch(e => stageMsg("Godot export failed: " + e.message, true)); };
  const unityBtn = $("#dlUnity");
  if (unityBtn) unityBtn.onclick = () => { downloadUnityPack().catch(e => stageMsg("Unity export failed: " + e.message, true)); };
  $("#dlFrames").onclick = () => {
    if (state.slicer && state.slicer.selection.length) {
      // slicer: export the picked frames in order
      let delay = 0;
      state.slicer.selection.forEach((pi, oi) => {
        const c = state.slicer.pieces[pi].canvas;
        setTimeout(() => downloadCanvas(c, `m4ster-slice-frame${oi}.png`), delay);
        delay += 350;
      });
      return;
    }
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
  ["#dlSheet", "#dlJson", "#dlFrames", "#dlAnim", "#dlBundle", "#dlGodot", "#dlUnity"].forEach(s => { const el = $(s); if (el) el.disabled = !on; });
}

/* ================= v6.10: engine export packs =================
 * One click per engine. Godot gets a real SpriteFrames .tres (plain text,
 * generated exactly). Unity gets the sheet pre-sliced via a hand-authored
 * .meta plus an Editor builder script that creates the .anim clips inside
 * Unity — clips reference sprites by name at editor time, so there is no
 * GUID guessing (the failure mode of shipping raw .anim YAML). */

/* --- stored (uncompressed) ZIP writer: local headers + central dir --- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}
async function fileBytes(data) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data && data.toBlob) { // canvas
    const blob = await new Promise(r => data.toBlob(r, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("zip: unsupported file data");
}
async function downloadZip(zipName, files) {
  const chunks = [], central = [];
  let offset = 0;
  const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const bytes = await fileBytes(f.data);
    const crc = crc32(bytes);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0x21), ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(name.length), ...u16(0), ...name
    ]);
    chunks.push(local, bytes);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0x21), ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...name
    ]));
    offset += local.length + bytes.length;
  }
  let cdSize = 0;
  for (const c of central) { chunks.push(c); cdSize += c.length; }
  chunks.push(new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length),
    ...u16(central.length), ...u32(cdSize), ...u32(offset), ...u16(0)
  ]));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  downloadBytes(out, zipName, "application/zip");
}

/* --- shared: flatten manifest animations to [{name, fps, loop, rects}] --- */
function manifestAnims(manifest) {
  return Object.entries(manifest.animations).map(([name, a]) => ({
    name,
    fps: a.fps || 8,
    loop: a.loop !== false,
    rects: (manifest.frameLayout.rows[name] || {}).rects || []
  })).filter(a => a.rects.length);
}
const safeName = s => String(s).replace(/[^a-zA-Z0-9_-]+/g, "_");

/* --- Godot: SpriteFrames .tres (Godot 4, Rect2 origin is top-left, y down
 * — exactly how our manifest stores rects, so no conversion) --- */
function godotTres(manifest, pngName) {
  const subs = [], animChunks = [];
  let si = 0;
  for (const a of manifestAnims(manifest)) {
    const frames = a.rects.map(r => {
      si++;
      subs.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${si}"]\natlas = ExtResource("1")\nregion = Rect2(${r.x}, ${r.y}, ${r.w}, ${r.h})`);
      return `{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_${si}")\n}`;
    });
    animChunks.push(`{\n"frames": [${frames.join(", ")}],\n"loop": ${a.loop},\n"name": &"${safeName(a.name)}",\n"speed": ${a.fps.toFixed(1)}\n}`);
  }
  return `[gd_resource type="SpriteFrames" format=3]\n\n` +
    `[ext_resource type="Texture2D" path="res://${pngName}" id="1"]\n\n` +
    subs.join("\n\n") + `\n\n[resource]\nanimations = [${animChunks.join(", ")}]\n`;
}

/* --- Unity: sidecar JSON the builder script reads --- */
function unitySidecar(manifest, pngName) {
  return JSON.stringify({
    tool: "m4ster FrameLab",
    texture: pngName,
    width: manifest.sheetWidth,
    height: manifest.sheetHeight,
    animations: manifestAnims(manifest).map(a => ({
      name: safeName(a.name), fps: a.fps, loop: a.loop, rects: a.rects
    }))
  }, null, 2);
}

/* --- Unity: pre-sliced .png.meta (bonus path — the builder script re-does
 * the slicing from the sidecar anyway, so a Unity version that regenerates
 * this file loses nothing). Unity rects are bottom-up: y flips. --- */
function unityMeta(manifest, guid) {
  const H = manifest.sheetHeight;
  const hex = n => Array.from({ length: n }, () => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");
  const sprites = [], idTable = [], nameTable = [];
  let idx = 0;
  for (const a of manifestAnims(manifest)) {
    a.rects.forEach((r, i) => {
      const nm = `${safeName(a.name)}_${i}`;
      const internalId = 21300000 + idx * 2;
      const spriteID = hex(32);
      sprites.push(
`    - serializedVersion: 2
      name: ${nm}
      rect:
        serializedVersion: 2
        x: ${r.x}
        y: ${H - r.y - r.h}
        width: ${r.w}
        height: ${r.h}
      alignment: 0
      pivot: {x: 0.5, y: 0}
      border: {x: 0, y: 0, z: 0, w: 0}
      outline: []
      customData:
      physicsShape: []
      bones: []
      spriteID: ${spriteID}
      internalID: ${internalId}
      vertices: []
      indices:
      edges: []
      weights: []`);
      idTable.push(`  - first:\n      213: ${internalId}\n    second: ${nm}`);
      nameTable.push(`      ${nm}: ${internalId}`);
      idx++;
    });
  }
  return `fileFormatVersion: 2
guid: ${guid}
TextureImporter:
  internalIDToNameTable:
${idTable.join("\n")}
  externalObjects: {}
  serializedVersion: 12
  mipmaps:
    mipMapMode: 0
    enableMipMap: 0
    sRGBTexture: 1
    linearTexture: 0
    fadeOut: 0
    borderMipMap: 0
    mipMapsPreserveCoverage: 0
    alphaTestReferenceValue: 0.5
    mipMapFadeDistanceStart: 1
    mipMapFadeDistanceEnd: 3
  bumpmap:
    convertToNormalMap: 0
    externalNormalMap: 0
    heightScale: 0.25
    normalMapFilter: 0
  isReadable: 0
  streamingMipmaps: 0
  streamingMipmapsPriority: 0
  vTOnly: 0
  ignoreMipmapLimit: 0
  grayScaleToAlpha: 0
  generateCubemap: 6
  cubemapConvolution: 0
  seamlessCubemap: 0
  textureFormat: 1
  maxTextureSize: 2048
  textureSettings:
    serializedVersion: 2
    filterMode: 0
    aniso: 1
    mipBias: 0
    wrapU: 1
    wrapV: 1
  nPOTScale: 0
  lightmap: 0
  compressionQuality: 50
  spriteMode: 2
  spriteExtrude: 1
  spriteMeshType: 1
  alignment: 0
  spritePivot: {x: 0.5, y: 0.5}
  spritePixelsToUnits: 100
  spriteBorder: {x: 0, y: 0, z: 0, w: 0}
  spriteGenerateFallbackPhysicsShape: 1
  alphaUsage: 1
  alphaIsTransparency: 1
  spriteTessellationDetail: -1
  textureType: 8
  textureShape: 1
  singleChannelComponent: 0
  flipbookRows: 1
  flipbookColumns: 1
  maxTextureSizeSet: 0
  compressionQualitySet: 0
  textureFormatSet: 0
  ignoreMipmapLimitSet: 0
  applyGammaDecoding: 0
  swizzle: 0
  cookieLightType: 0
  platformSettings:
  - serializedVersion: 3
    buildTarget: DefaultTexturePlatform
    maxTextureSize: 2048
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 1
    compressionQuality: 50
    crunchedCompression: 0
    allowsAlphaSplitting: 0
    overridden: 0
    ignorePlatformSupport: 0
    androidETC2FallbackOverride: 0
    forceMaximumCompressionQuality_Bakery: 0
  spriteSheet:
    serializedVersion: 2
    sprites:
${sprites.join("\n")}
    nameFileIdTable:
${nameTable.join("\n")}
  mipmapLimitGroupName:
  pSDRemoveMatte: 0
  userData:
  assetBundleName:
  assetBundleVariant:
`;
}

/* --- Unity: Editor builder script (plain text asset, written like any
 * editor tool: menu click -> slice from sidecar -> build clips by name) --- */
const UNITY_BUILDER_CS = `// FrameLabAnimBuilder.cs
// Generated by m4ster FrameLab (https://m4ster-framelab.vercel.app).
// Drop this file into any Editor folder in your Unity project, keep it next
// to the FrameLab pack (sheet PNG + framelab-unity.json), then run:
//   FrameLab > Build Animation Clips
// It slices the sheet from the sidecar data and creates one .anim clip per
// animation, plus a ready AnimatorController. Sprites are resolved by name
// inside the editor, so references can never arrive broken.

using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

public static class FrameLabAnimBuilder
{
    [System.Serializable]
    private class RectJ { public int x; public int y; public int w; public int h; }

    [System.Serializable]
    private class AnimJ { public string name; public float fps; public bool loop; public RectJ[] rects; }

    [System.Serializable]
    private class PackJ { public string texture; public int width; public int height; public AnimJ[] animations; }

    [MenuItem("FrameLab/Build Animation Clips")]
    public static void Build()
    {
        string jsonPath = FindSidecar();
        if (jsonPath == null)
        {
            EditorUtility.DisplayDialog("FrameLab", "framelab-unity.json not found in the project.", "OK");
            return;
        }

        string dir = Path.GetDirectoryName(jsonPath).Replace("\\\\", "/");
        var pack = JsonUtility.FromJson<PackJ>(File.ReadAllText(jsonPath));
        string texPath = dir + "/" + pack.texture;
        var importer = AssetImporter.GetAtPath(texPath) as TextureImporter;
        if (importer == null)
        {
            EditorUtility.DisplayDialog("FrameLab", "Sheet texture not found next to the sidecar: " + texPath, "OK");
            return;
        }

        // Slice the sheet exactly as the sidecar says. Unity rects are
        // bottom-up, FrameLab rects are top-down, so y flips here.
        importer.textureType = TextureImporterType.Sprite;
        importer.spriteImportMode = SpriteImportMode.Multiple;
        importer.filterMode = FilterMode.Point;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        var metas = new List<SpriteMetaData>();
        foreach (var anim in pack.animations)
        {
            for (int i = 0; i < anim.rects.Length; i++)
            {
                var r = anim.rects[i];
                metas.Add(new SpriteMetaData
                {
                    name = anim.name + "_" + i,
                    rect = new Rect(r.x, pack.height - r.y - r.h, r.w, r.h),
                    alignment = (int)SpriteAlignment.Custom,
                    pivot = new Vector2(0.5f, 0f)
                });
            }
        }
        importer.spritesheet = metas.ToArray();
        importer.SaveAndReimport();

        var sprites = new Dictionary<string, Sprite>();
        foreach (var obj in AssetDatabase.LoadAllAssetsAtPath(texPath))
        {
            var spr = obj as Sprite;
            if (spr != null) sprites[spr.name] = spr;
        }

        string animDir = dir + "/Animations";
        if (!AssetDatabase.IsValidFolder(animDir))
            AssetDatabase.CreateFolder(dir, "Animations");

        string controllerPath = animDir + "/FrameLab.controller";
        if (File.Exists(controllerPath)) AssetDatabase.DeleteAsset(controllerPath);
        var controller = AnimatorController.CreateAnimatorControllerAtPath(controllerPath);
        var stateMachine = controller.layers[0].stateMachine;
        AnimatorState firstState = null;

        foreach (var anim in pack.animations)
        {
            var keys = new List<ObjectReferenceKeyframe>();
            for (int i = 0; i < anim.rects.Length; i++)
            {
                Sprite spr;
                if (!sprites.TryGetValue(anim.name + "_" + i, out spr)) continue;
                keys.Add(new ObjectReferenceKeyframe { time = i / anim.fps, value = spr });
            }
            if (keys.Count == 0) continue;
            // terminal keyframe: hold the last sprite for its full slot
            keys.Add(new ObjectReferenceKeyframe
            {
                time = anim.rects.Length / anim.fps,
                value = keys[keys.Count - 1].value
            });

            var clip = new AnimationClip { frameRate = anim.fps };
            var settings = AnimationUtility.GetAnimationClipSettings(clip);
            settings.loopTime = anim.loop;
            AnimationUtility.SetAnimationClipSettings(clip, settings);
            var binding = new EditorCurveBinding
            {
                type = typeof(SpriteRenderer),
                path = "",
                propertyName = "m_Sprite"
            };
            AnimationUtility.SetObjectReferenceCurve(clip, binding, keys.ToArray());
            string clipPath = animDir + "/" + anim.name + ".anim";
            if (File.Exists(clipPath)) AssetDatabase.DeleteAsset(clipPath);
            AssetDatabase.CreateAsset(clip, clipPath);

            var state = stateMachine.AddState(anim.name);
            state.motion = clip;
            if (firstState == null) firstState = state;
        }
        if (firstState != null) stateMachine.defaultState = firstState;

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        EditorUtility.DisplayDialog("FrameLab",
            "Built " + pack.animations.Length + " animation clip(s) + FrameLab.controller in " + animDir, "OK");
    }

    private static string FindSidecar()
    {
        string[] guids = AssetDatabase.FindAssets("framelab-unity");
        foreach (var guid in guids)
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            if (path.EndsWith("framelab-unity.json")) return path;
        }
        return null;
    }
}
`;

const GODOT_README = `m4ster FrameLab — Godot pack
============================

Files:
- m4ster-sprite-sheet.png   the sprite sheet
- animations.tres           a Godot 4 SpriteFrames resource (every animation, fps + loop set)

Use it:
1. Copy both files into your Godot project (keep them in the same folder).
2. Add an AnimatedSprite2D node.
3. In the Inspector, set its Sprite Frames to animations.tres
   (click the Sprite Frames field > Load > pick the file).
4. Pick an animation in the editor and press play, or from code:
       $AnimatedSprite2D.play("walk")

If you move the PNG, open animations.tres in a text editor and fix the
path on the [ext_resource ...] line so it points at the PNG
(res:// = your project root).
`;

const UNITY_README = `m4ster FrameLab — Unity pack
============================

Files:
- m4ster-sprite-sheet.png        the sprite sheet (arrives pre-sliced via the .meta)
- m4ster-sprite-sheet.png.meta   texture importer data with every frame sliced
- framelab-unity.json            sidecar data (frame rects, fps, loop per animation)
- FrameLabAnimBuilder.cs         editor script that builds the .anim clips

Use it:
1. Copy all four files into your Unity project's Assets (same folder).
   Keep FrameLabAnimBuilder.cs inside a folder named "Editor".
2. In Unity, run the menu:  FrameLab > Build Animation Clips
3. You get one .anim per animation + FrameLab.controller in an
   "Animations" folder next to the sheet. Put a SpriteRenderer +
   Animator on your character, assign the controller, done.

Why a builder script? Raw .anim files reference sprites by internal IDs
that only Unity can assign. The script resolves sprites by name inside
the editor, so clips can never arrive with "Missing (Sprite)".
`;

async function downloadGodotPack() {
  if (!state.atlas) return;
  const m = state.atlas.manifest, pngName = state.atlas.pngName;
  const png = await fileBytes(state.atlas.canvas);
  await downloadZip("m4ster-framelab-godot.zip", [
    { name: pngName, data: png },
    { name: "animations.tres", data: godotTres(m, pngName) },
    { name: "README-godot.txt", data: GODOT_README }
  ]);
  stageMsg("Godot pack downloaded — unzip into your project, point an AnimatedSprite2D at animations.tres.");
}

async function downloadUnityPack() {
  if (!state.atlas) return;
  const m = state.atlas.manifest, pngName = state.atlas.pngName;
  const guid = Array.from({ length: 32 }, () => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");
  const png = await fileBytes(state.atlas.canvas);
  await downloadZip("m4ster-framelab-unity.zip", [
    { name: pngName, data: png },
    { name: pngName + ".meta", data: unityMeta(m, guid) },
    { name: "framelab-unity.json", data: unitySidecar(m, pngName) },
    { name: "FrameLabAnimBuilder.cs", data: UNITY_BUILDER_CS },
    { name: "README-unity.txt", data: UNITY_README }
  ]);
  stageMsg("Unity pack downloaded — unzip into Assets, then run FrameLab > Build Animation Clips.");
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
  royal:   { skin: ["#f2c69b", "#e0a878", "#c98a5b", "#a96f45"], hue: 265, accent: 45 },
  shadow:  { skin: ["#b8bcc4", "#9aa0ab", "#7c828e", "#5f646e"], hue: 230, accent: 350 },
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
  if (arch === "ghost")     return procGhost(p, stateName, seedNum);
  return procBiped(p, stateName, seedNum);
}

function procBiped(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919);
  const count = p.frames;
  const W = 32, H = 44, S = 4;
  const pal = procPalette(p.palette, rng);
  const skin = pal.skin, shirt = pal.cloth, shirtD = pal.clothD, pants = pal.pants;
  const hairC = ["#2b2b2b", "#5a3a22", "#8a5a2b", "#d8d8d8"][(rng() * 4) | 0];
  const hairStyle = (rng() * 3) | 0; // 0 flat top, 1 sideburns, 2 mohawk

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
    px(ctx, 10, Y(2), 12, 4, hairC);
    if (hairStyle === 1) { px(ctx, 10, Y(5), 2, 6, hairC); px(ctx, 20, Y(5), 2, 6, hairC); }
    else if (hairStyle === 2) { px(ctx, 15, Y(0), 2, 3, hairC); }
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
  // visible per-seed variant (drawn once per generation — same across all frames)
  const earH = 3 + ((rng() * 3) | 0);
  const tailLen = 8 + ((rng() * 5) | 0);
  const spots = rng() < 0.5;
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
    limb(ctx, 10, Y(14), tailLen, -35 + Math.sin(ph * 2) * 12, 3, furD); // tail wag
    px(ctx, 12 + lunge, Y(11), 22, 10, fur);               // body
    px(ctx, 12 + lunge, Y(18), 22, 3, belly);              // belly
    px(ctx, 12 + lunge, Y(11), 22, 2, furD);               // back ridge
    if (spots) { px(ctx, 16 + lunge, Y(12), 5, 3, furD); px(ctx, 25 + lunge, Y(15), 4, 3, furD); } // spots
    px(ctx, 32 + lunge, Y(5) + headDy, 9, 9, fur);         // head
    px(ctx, 33 + lunge, Y(3) + headDy - (earH - 3), 4, earH, furD); // ear
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
  // visible per-seed variant (drawn once per generation — same across all frames)
  const beakC = ["#f5a623", "#e2574c", "#4dd07c", "#7c9aff"][(rng() * 4) | 0];
  const crestOn = rng() < 0.65;
  const wingLen = 12 + ((rng() * 4) | 0);
  const tailN = 2 + ((rng() * 2) | 0);
  const footC = ["#d98a2b", "#8a5a2b", "#6b7280"][(rng() * 3) | 0];
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
    for (let t = 0; t < tailN; t++) limb(ctx, 10, Y(20), 8, 50 + t * 18, 3, bodyD); // tail feathers
    px(ctx, 12 + lean, Y(14), 13, 11, body);              // body
    px(ctx, 12 + lean, Y(22), 13, 3, bodyD);
    px(ctx, 23 + lean, Y(10), 8, 8, body);                // head
    px(ctx, 30 + lean, Y(12), 4, 3, beakC);               // beak
    px(ctx, 26 + lean, Y(12), 2, 2, "#1a1a1a");           // eye
    if (crestOn) px(ctx, 24 + lean, Y(7), 2, 3, pal.accent); // crest
    const [wx, wy] = limb(ctx, 17 + lean, Y(15), wingLen, -55 - flap, 4, body); // near wing
    px(ctx, Math.round(wx) - 2, Math.round(wy) - 1, 5, 3, bodyD);
    px(ctx, 16 + lean, Y(26), 3, 2, footC);               // tucked feet
    px(ctx, 21 + lean, Y(26), 3, 2, footC);
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
  // visible per-seed variant (drawn once per generation — same across all frames)
  const eyeStyle = (rng() * 3) | 0;   // 0 round, 1 angry, 2 happy
  const drips = (rng() * 3) | 0;      // 0..2 side drips
  const shineDX = -2 + ((rng() * 5) | 0);
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
    px(ctx, cx + shineDX, baseY + 2, 3, 3, "#ffffff");
    for (let d = 0; d < drips; d++) px(ctx, cx - bw / 2 - 2 - d * 3, baseY + 8 + d * 4, 2, 4, goo); // side drips
    const ey = baseY + 8;
    if (eyeStyle === 2) { // happy ^ ^
      px(ctx, cx - 7, ey + 1, 4, 2, "#1a1a1a"); px(ctx, cx + 3, ey + 1, 4, 2, "#1a1a1a");
    } else if (eyeStyle === 1) { // angry
      px(ctx, cx - 8, ey - 2, 6, 2, "#1a1a1a"); px(ctx, cx + 2, ey - 2, 6, 2, "#1a1a1a");
      px(ctx, cx - 7, ey + 1, 4, 4, "#ffffff"); px(ctx, cx + 3, ey + 1, 4, 4, "#ffffff");
      px(ctx, cx - 6, ey + 2, 2, 2, "#1a1a1a"); px(ctx, cx + 4, ey + 2, 2, 2, "#1a1a1a");
    } else { // round
      px(ctx, cx - 7, ey, 4, 5, "#ffffff"); px(ctx, cx + 3, ey, 4, 5, "#ffffff");
      px(ctx, cx - 6, ey + 2, 2, 2, "#1a1a1a"); px(ctx, cx + 4, ey + 2, 2, 2, "#1a1a1a");
    }
    if (stateName === "attack") px(ctx, cx - 4, ey + 7, 8, 2, "#1a1a1a");
    selectiveOutline(cell, "#141414");
    const sctx = strip.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(cell, 0, 0, W, H, f * W * S, 0, W * S, H * S);
  }
  return strip;
}

/* ghost: floating sheet body, wavy hem, never touches the ground.
 * Every state is a drift — bob, sway, stretch — instead of steps. */
function procGhost(p, stateName, seedNum) {
  const rng = mulberry32(seedNum + stateName.length * 7919 + 607);
  const pal = procPalette(p.palette, rng);
  const count = p.frames, W = 36, H = 40, S = 4;
  const body = "#e9edf5", shade = "#c3ccd9";
  const glow = pal.accent;
  const eyeStyle = (rng() * 2) | 0; // 0 round dark, 1 glowing
  const strip = makeCanvas(W * count * S, H * S);
  for (let f = 0; f < count; f++) {
    const cell = makeCanvas(W, H);
    const ctx = cell.getContext("2d");
    const ph = (f / count) * Math.PI * 2;
    let yOff = Math.round(Math.sin(ph) * 2), xOff = 0, stretch = 0, lean = 0;
    if (stateName === "walk")       { yOff = -2 + Math.round(Math.sin(ph) * 2); xOff = Math.round(Math.sin(ph) * 1); }
    else if (stateName === "run")   { yOff = -3 + Math.round(Math.sin(ph * 2) * 1); lean = 2; }
    else if (stateName === "jump")  { const k = f / Math.max(1, count - 1), air = Math.sin(k * Math.PI); yOff = -Math.round(air * 7); stretch = Math.round(air * 3); }
    else if (stateName === "attack") { const k = f / Math.max(1, count - 1); xOff = Math.round(Math.sin(k * Math.PI) * 6); }
    const cx = 18 + xOff, top = 6 + yOff, bw = 22, bh = 24 + stretch;
    // sheet body: dome rows narrowing at the top, straight sides
    px(ctx, cx - bw / 2 + 6 + lean, top, bw - 12, 4, body);
    px(ctx, cx - bw / 2 + 3 + lean, top + 4, bw - 6, 4, body);
    px(ctx, cx - bw / 2, top + 8, bw, bh - 8, body);
    px(ctx, cx - bw / 2, top + 8, 4, bh - 8, shade); // left shading
    // wavy hem: three scallops, phase-shifted per frame so it ripples
    for (let sIdx = 0; sIdx < 3; sIdx++) {
      const hx = cx - bw / 2 + 1 + sIdx * 7;
      const dip = 2 + Math.round(Math.sin(ph + sIdx * 2.1) * 1.5);
      px(ctx, hx, top + bh, 6, dip, body);
      px(ctx, hx, top + bh, 2, dip, shade);
    }
    // stub arms — out to the sides, forward on attack
    const armY = top + 13;
    if (stateName === "attack") {
      px(ctx, cx + bw / 2 - 1, armY, 7, 3, body);
      px(ctx, cx - bw / 2 - 6, armY + 2, 7, 3, body);
    } else {
      px(ctx, cx - bw / 2 - 4, armY + Math.round(Math.sin(ph) * 1), 5, 3, body);
      px(ctx, cx + bw / 2 - 1, armY - Math.round(Math.sin(ph) * 1), 5, 3, body);
    }
    // face
    const ey = top + 11, ex = cx + lean;
    if (eyeStyle === 1) {
      px(ctx, ex - 7, ey, 4, 5, glow); px(ctx, ex + 3, ey, 4, 5, glow);
    } else {
      px(ctx, ex - 7, ey, 4, 5, "#232733"); px(ctx, ex + 3, ey, 4, 5, "#232733");
    }
    if (stateName === "attack") px(ctx, ex - 2, ey + 8, 5, 6, "#232733"); // open wail mouth
    else px(ctx, ex - 1, ey + 8, 3, 4, "#232733");
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
  const metalHue = (rng() * 360) | 0;
  const metal = `hsl(${metalHue},12%,62%)`, metalD = `hsl(${metalHue},12%,45%)`, joint = `hsl(${metalHue},10%,28%)`;
  // visible per-seed variant (drawn once per generation — same across all frames)
  const visorC = ["#ff3b30", "#34e07c", "#4da6ff", "#ffd60a"][(rng() * 4) | 0];
  const antennaOn = rng() < 0.7;
  const chestC = rng() < 0.5 ? pal.accent : visorC;
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
    px(ctx, 14, Y(18), 4, 4, chestC);
    px(ctx, 11, Y(4), 10, 8, metal);
    const visorOn = !(stateName === "idle" && f % 4 === 3);
    px(ctx, 12, Y(6), 8, 3, visorOn ? visorC : joint);
    if (antennaOn) {
      px(ctx, 15, Y(2), 2, 2, joint);
      px(ctx, 15, Y(0), 2, 2, (f % 2) ? visorC : joint);
    }
    for (const [sx, ang] of [[9, armL], [23, armR]]) {
      const [ex, ey] = limb(ctx, sx, Y(15), 7, quant(ang), 4, joint);
      limb(ctx, ex, ey, 6, quant(ang * 0.6), 4, metal);
    }
    if (cannon) {
      limb(ctx, 23, Y(15), 12, 90, 5, metalD);
      px(ctx, 30, Y(13), 4, 5, visorC);
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

const TILE_PATTERNS = ["grass", "sand", "stone", "brick", "wood", "metal", "water", "dungeon", "lava", "snow"];

/* returns an ARRAY of canvases (water shimmers: 2 frames, everything else 1) */
function procTile(pattern, size, seedNum) {
  const frames = (pattern === "water" || pattern === "lava") ? 2 : 1;
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
    } else if (pattern === "lava") {
      px(ctx, 0, 0, S, S, "#2e2320");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 10; i++) px(ctx, R(0, S), R(0, S), R(2, 5), R(2, 4), "#241a17"); // basalt blotches
        // glowing cracks: short random walks; frame 2 burns brighter
        const hot = fr === 1 ? "#ffd23f" : "#ff7b1c";
        for (let i = 0; i < 4; i++) {
          let x = R(0, S), y = R(0, S);
          for (let k = 0; k < 9; k++) {
            px(ctx, x, y, 2, 1, "#ff9a3c");
            px(ctx, x, y, 1, 1, hot);
            x += R(-3, 3); y += R(-2, 2);
          }
        }
        for (let i = 0; i < 6; i++) px(ctx, R(0, S), R(0, S), 1, 1, "#57443a");
      });
    } else if (pattern === "snow") {
      px(ctx, 0, 0, S, S, "#e8eef5");
      wrapped(ctx, S, () => {
        for (let i = 0; i < 7; i++) px(ctx, R(0, S), R(0, S), R(3, 6), R(1, 2), "#f7fafc"); // soft drifts
        for (let i = 0; i < 9; i++) px(ctx, R(0, S), R(0, S), R(2, 4), 1, "#ccd9e6");          // shadowed dips
        for (let i = 0; i < 12; i++) px(ctx, R(0, S), R(0, S), 1, 1, "#ffffff");               // sparkle
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
    } else if (type === "heal") {
      // rising plus-signs + motes, breathing alpha: fade in, float up, fade out
      const glowA = Math.sin(t * Math.PI);
      for (let i = 0; i < 5; i++) {
        const x = cx + (rng() - 0.5) * 30, y = cy + 16 - t * 30 - rng() * 8;
        const s = 2 + ((rng() * 2) | 0);
        ctx.fillStyle = rng() > 0.4 ? "#3ddc84" : "#baffd9";
        ctx.globalAlpha = 0.35 + glowA * 0.65;
        ctx.fillRect(x - s, y - 1, s * 2 + 1, 2);
        ctx.fillRect(x - 1, y - s, 2, s * 2 + 1);
      }
      for (let i = 0; i < 12; i++) {
        const x = cx + (rng() - 0.5) * 36, y = cy + 18 - t * 34 - rng() * 6;
        ctx.fillStyle = "#eafff3";
        ctx.globalAlpha = glowA * (0.4 + rng() * 0.5);
        ctx.fillRect(x, y, 2, 2);
      }
      ctx.globalAlpha = 1;
    } else if (type === "portal") {
      // two dot-rings rotating opposite ways, swelling then settling
      const swell = Math.sin(Math.min(1, t * 1.15) * Math.PI);
      for (let ringI = 0; ringI < 2; ringI++) {
        const radius = 7 + ringI * 6 + swell * 4;
        const dots = 14 + ringI * 6;
        const dir = ringI === 0 ? 1 : -1;
        for (let i = 0; i < dots; i++) {
          const a = (i / dots) * Math.PI * 2 + dir * t * Math.PI * 3 + ringI;
          const x = cx + Math.cos(a) * radius, y = cy + Math.sin(a) * radius * 0.92;
          ctx.fillStyle = ringI === 0 ? "#c084fc" : "#7df9ff";
          ctx.globalAlpha = 0.55 + swell * 0.45;
          const sz = ringI === 0 ? 3 : 2;
          ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        }
      }
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
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
  const bmp = await aiGenerateImage(prompt, 512, 512, (msg) => {
    setStep("row", "active", `tile gen — ${msg}`);
  });
  const full = makeCanvas(bmp.width, bmp.height);
  full.getContext("2d").drawImage(bmp, 0, 0);
  const out = makeCanvas(size, size);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(full, 0, 0, size, size);
  return out;
}

/* ---------------- v6.9: one still in, motion out ----------------
 * Asking an image model for a whole pose strip is how characters end up
 * sliced across frames. So in still mode the model draws exactly ONE
 * character; every animation row is then derived from that single drawing
 * with deterministic transforms — the character can never be cut, merged,
 * or redesigned between frames. Breathe (idle) is the same trick the
 * procedural engine uses: squash & stretch anchored at the feet. */

function buildStillPrompt(p) {
  const key = keyName();
  const flatBg = `solid flat single-color ${key} background filling the ENTIRE image edge to edge, ` +
    `absolutely no gradient, no shading, no vignette, no border, no frame, no scenery, ` +
    `no floor, no backdrop details, no decorative shape or splash behind the character — ` +
    `the character stands directly on the plain background`;
  return `2D game character sprite, ${describe("brave knight")}, ${p.style} style, ${(p.archetype || "biped")} body plan, ` +
    `ONE single character only, standing in a relaxed neutral pose, ${p.view} view, ` +
    `full body visible, feet on the same ground line, generous empty space on all sides, ` +
    `clean flat colors, bold readable silhouette, ` +
    flatBg + `, no shadows, no outline glow, no text, no watermark, game asset`;
}

/* crop a keyed canvas to its visible content, then re-pad evenly so motion
 * (lunges, falls) has headroom inside the cell */
function trimToContent(src, padFrac) {
  const w = src.width, h = src.height;
  const px = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[(y * w + x) * 4 + 3] > 12) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) fail("the AI still came back empty after keying — try another model or prompt.");
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const padX = Math.round(cw * padFrac), padY = Math.round(ch * padFrac);
  const out = makeCanvas(cw + padX * 2, ch + padY * 2);
  out.getContext("2d").drawImage(src, x0, y0, cw, ch, padX, padY, cw, ch);
  return out;
}

/* derive one animation row from the single still. Anchor is the feet
 * (bottom-center): squash, bob, lunge and fall all pivot there, so the
 * ground line never drifts. */
function animateStill(frame, sname, count) {
  /* a falling body sweeps sideways by its own height — give the death row
   * a square cell so the fall never clips at the frame edge */
  if (sname === "death" && frame.width < frame.height) {
    const S = frame.height;
    const sq = makeCanvas(S, S);
    sq.getContext("2d").drawImage(frame, (S - frame.width) / 2, S - frame.height);
    frame = sq;
  }
  const W = frame.width, H = frame.height, TAU = Math.PI * 2;
  const frames = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / count;
    const ph = t * TAU;
    let sx = 1, sy = 1, dx = 0, dy = 0, rot = 0;
    if (sname === "walk") {
      dy = -H * 0.035 * Math.abs(Math.sin(ph));
      rot = 0.035 * Math.sin(ph);
      sy = 1 + 0.012 * Math.sin(2 * ph);
    } else if (sname === "run") {
      dy = -H * 0.06 * Math.abs(Math.sin(ph));
      rot = 0.06 + 0.04 * Math.sin(ph);
      sy = 1 + 0.02 * Math.sin(2 * ph);
    } else if (sname === "jump") {
      const a = Math.sin(Math.PI * t);
      dy = -H * 0.20 * a;
      sy = 1 + 0.08 * a; sx = 1 - 0.04 * a;
    } else if (sname === "attack") {
      const a = Math.sin(Math.PI * Math.min(1, t * 1.35));
      dx = W * 0.14 * a; rot = 0.07 * a; sy = 1 - 0.03 * a;
    } else if (sname === "hurt") {
      const decay = 1 - t;
      dx = W * 0.03 * Math.sin(ph * 3) * decay;
      rot = 0.05 * Math.sin(ph * 3) * decay;
    } else if (sname === "death") {
      const a = t * t;
      rot = -1.45 * a; dy = H * 0.16 * a;
      sx = 1 - 0.10 * a; sy = 1 - 0.25 * a;
    } else { /* idle + anything else: breathe */
      sy = 1 + 0.028 * Math.sin(ph);
      sx = 1 - 0.012 * Math.sin(ph);
      dy = -H * 0.006 * (0.5 - 0.5 * Math.cos(ph));
    }
    const c = makeCanvas(W, H);
    const ctx = c.getContext("2d");
    ctx.translate(W / 2 + dx, H + dy);
    ctx.rotate(rot);
    ctx.scale(sx, sy);
    ctx.drawImage(frame, -W / 2, -H);
    frames.push(c);
  }
  return frames;
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
      /* v6.9 still mode: ONE AI drawing up front, every state row derived
       * from it below — the model never gets to slice a pose strip. */
      const stillMode = state.source === "ai" && state.aiStyle === "still";
      let stillCell = null;
      if (stillMode) {
        const sPrompt = buildStillPrompt(p);
        showPromptPeek(sPrompt);
        stageMsg(`prompt [still]: ${sPrompt}`);
        setStep("prompt", "done");
        setStep("row", "active", "drawing ONE character still…");
        const bmp = await aiGenerateImage(sPrompt, 1024, 1024, (msg) => {
          setStep("row", "active", `still — ${msg}`);
        });
        const rawStill = makeCanvas(bmp.width, bmp.height);
        rawStill.getContext("2d").drawImage(bmp, 0, 0);
        showStage(rawStill, `still: raw ${bmp.width}×${bmp.height} — one drawing, every row comes from this`);
        setStep("row", "done");
        setStep("alpha", "active", "flood keying the background…");
        let keyedStill = floodKey(rawStill);
        if (hollowCenter(keyedStill) || clearedFrac(keyedStill) < 0.08) {
          // two ways keying fails: it leaked into the subject (hollow
          // middle) or it removed almost nothing (backdrop still glued on,
          // frames would bob as one rectangle). Retry with the flat
          // selected key colour; if that fails both checks too, the still
          // genuinely can't be separated — say so, don't ship scraps.
          stageMsg("first keying pass didn't separate cleanly — retrying with the flat key colour…", "warn");
          const alt = chromaKey(rawStill, state.key);
          if (!hollowCenter(alt) && clearedFrac(alt) >= 0.08) keyedStill = alt;
          else fail("Couldn't separate this character from its background — it would animate as a whole picture, not a sprite. Pick AI Horde · Deliberate or Pollinations · FLUX (harder edges), or use the AI strip mode.");
        }
        showStage(keyedStill, "still: background keyed out");
        setStep("alpha", "done");
        checkKeyCoverage(keyedStill);
        setStep("extract", "active", "lifting the character out…");
        const stillFrame = extractFramesRobust(keyedStill, 1, { align: "bottom" }).frames[0];
        stillCell = trimToContent(keepLargestBlob(stillFrame), 0.16);
        setStep("extract", "done", "one clean still — animating it in-house");
      }
      for (const sname of p.states) {
        if (stillMode) {
          setStep("row", "active", `animating [${sname}] from the still…`);
          const frames = animateStill(stillCell, sname, p.frames);
          pushRow(sname, frames, {
            fps: STATE_FPS[sname] || 8,
            loop: !["death", "jump", "attack", "hurt"].includes(sname),
            stillAnimated: true
          });
          setStep("row", "done", `[${sname}] animated from the still`);
          continue;
        }
        const prompt = buildPrompt(cat, p, sname, state.strict);
        showPromptPeek(prompt);
        stageMsg(`prompt [${sname}]: ${prompt}`);
        setStep("prompt", "done");
        setStep("row", "active", `row gen [${sname}] — one AI call, ${p.frames} poses on flat ${keyName()}…`);
        let strip;
        if (state.source === "ai") strip = await genRowAI(prompt, p.frames, 384, sname);
        else strip = procCharacter(p, sname, seed);
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
      else tileFrames = procTile(p.pattern, p.size, seed);
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
      else strip = procUI(p.kind, p.states, seed);
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
      else strip = procEffect(p.type, p.frames, seed);
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

/* ================= v6.5: image → pixel art (pure pixel pipeline, DOM-free) =================
 * Every function below operates on plain {data:Uint8ClampedArray, w, h} pixel
 * buffers — no canvas, no DOM — so the whole pipeline unit-tests in node.
 * Alpha is preserved throughout: quantization and dithering touch RGB only;
 * fully transparent pixels stay fully transparent. */

/* box-average downscale: deterministic, identical in browser and node */
function pxDownscaleData(src, dw, dh) {
  const data = src.data, sw = src.w, sh = src.h;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * sw + xx) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++;
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { data: out, w: dw, h: dh };
}

/* median-cut: px = array of [r,g,b]; returns palette of ≤ maxColors [r,g,b] */
function pxMedianCut(px, maxColors) {
  if (!px.length || maxColors < 1) return [];
  const rangeOf = (box) => {
    const mn = [255, 255, 255], mx = [0, 0, 0];
    for (const p of box) for (let c = 0; c < 3; c++) {
      if (p[c] < mn[c]) mn[c] = p[c];
      if (p[c] > mx[c]) mx[c] = p[c];
    }
    return { mn, mx };
  };
  const boxes = [px.slice()];
  while (boxes.length < maxColors) {
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.length < 2) continue;
      const { mn, mx } = rangeOf(b);
      const range = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
      const score = range * Math.log2(b.length + 1);
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0) break;
    const box = boxes[bi];
    const { mn, mx } = rangeOf(box);
    let ch = 0;
    if (mx[1] - mn[1] > mx[ch] - mn[ch]) ch = 1;
    if (mx[2] - mn[2] > mx[ch] - mn[ch]) ch = 2;
    box.sort((a, b2) => a[ch] - b2[ch]);
    const mid = Math.floor(box.length / 2);
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map(b => {
    let r = 0, g = 0, bl = 0;
    for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
    const n = b.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}

function pxNearestColor(palette, r, g, b) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d = (p[0] - r) * (p[0] - r) + (p[1] - g) * (p[1] - g) + (p[2] - b) * (p[2] - b);
    if (d < bd) { bd = d; bi = i; }
  }
  return palette[bi];
}

/* quantize RGB to ≤ maxColors; maxColors 0 = full color (copy). Alpha untouched. */
function pxQuantize(src, maxColors) {
  const data = src.data, w = src.w, h = src.h;
  const out = new Uint8ClampedArray(data.length);
  if (!maxColors || maxColors >= 256) { out.set(data); return { data: out, w, h }; }
  const opaque = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8) opaque.push([data[i], data[i + 1], data[i + 2]]);
  }
  const palette = pxMedianCut(opaque, maxColors);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a <= 8 || !palette.length) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; continue; }
    const c = pxNearestColor(palette, data[i], data[i + 1], data[i + 2]);
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = a;
  }
  return { data: out, w, h };
}

/* Floyd–Steinberg dithering over a quantized buffer. RGB only; alpha preserved. */
function pxDitherFS(src, maxColors) {
  const data = src.data, w = src.w, h = src.h;
  const f = new Float32Array(data);
  const opaque = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8) opaque.push([data[i], data[i + 1], data[i + 2]]);
  }
  const palette = pxMedianCut(opaque, maxColors);
  const out = new Uint8ClampedArray(data.length);
  const spread = (x, y, er, dx, dy, fct) => {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
    const ni = (ny * w + nx) * 4;
    if (data[ni + 3] <= 8) return;
    f[ni] += er[0] * fct; f[ni + 1] += er[1] * fct; f[ni + 2] += er[2] * fct;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = data[i + 3];
      if (a <= 8 || !palette.length) { out[i] = out[i + 1] = out[i + 2] = 0; out[i + 3] = 0; continue; }
      const oldR = f[i], oldG = f[i + 1], oldB = f[i + 2];
      const nc = pxNearestColor(palette, oldR, oldG, oldB);
      out[i] = nc[0]; out[i + 1] = nc[1]; out[i + 2] = nc[2]; out[i + 3] = a;
      const er = [oldR - nc[0], oldG - nc[1], oldB - nc[2]];
      spread(x, y, er, 1, 0, 7 / 16); spread(x, y, er, -1, 1, 3 / 16);
      spread(x, y, er, 0, 1, 5 / 16); spread(x, y, er, 1, 1, 1 / 16);
    }
  }
  return { data: out, w, h };
}

/* nearest-neighbor upscale — crisp pixels, never blurry */
function pxUpscaleNearest(src, scale) {
  const data = src.data, w = src.w, h = src.h;
  const W = w * scale, H = h * scale;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < W; x++) {
      const sx = Math.floor(x / scale);
      const si = (sy * w + sx) * 4, oi = (y * W + x) * 4;
      out[oi] = data[si]; out[oi + 1] = data[si + 1]; out[oi + 2] = data[si + 2]; out[oi + 3] = data[si + 3];
    }
  }
  return { data: out, w: W, h: H };
}

/* full pipeline: downscale → quantize (or dither). colors 0 = full color. */
function pxConvert(src, opts) {
  const small = pxDownscaleData(src, opts.w, opts.h);
  if (!opts.colors) return small;
  return opts.dither ? pxDitherFS(small, opts.colors) : pxQuantize(small, opts.colors);
}

/* ---------- v6.5: pixel-art converter wiring (browser side) ---------- */

function pxState() {
  if (!state.pixelart) {
    const d = CATEGORY_DEFAULTS.pixelart;
    state.pixelart = { src: null, imgW: 0, imgH: 0, w: d.w, h: d.h, colors: d.colors, dither: false, scale: 8, grid: false, tile: 32, out: null };
  }
  return state.pixelart;
}

function pxColorLabel(n) {
  return n === 0 ? "full color" : n + " colors";
}

function syncPixelMode() {
  const on = state.category === "pixelart";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-pixelart", on);
  if (stage) stage.classList.toggle("mode-pixelart", on);
  document.body.classList.toggle("mode-pixelart", on);
  const side = $("#pixelSide");
  if (side) side.hidden = !(on && state.pixelart && state.pixelart.src);
}

function pxRender() {
  const P = pxState();
  const side = $("#pixelSide");
  if (!P.src) { if (side) side.hidden = true; return; }
  const t0 = performance.now();
  P.out = pxConvert(P.src, { w: P.w, h: P.h, colors: P.colors, dither: P.dither });
  const ms = Math.round(performance.now() - t0);

  const oc = $("#pxOrig"), pc = $("#pxOut");
  oc.width = P.imgW; oc.height = P.imgH;
  const octx = oc.getContext("2d");
  const tmp = document.createElement("canvas");
  tmp.width = P.src.w; tmp.height = P.src.h;
  tmp.getContext("2d").putImageData(new ImageData(P.src.data, P.src.w, P.src.h), 0, 0);
  octx.drawImage(tmp, 0, 0);
  oc.style.maxWidth = "100%";

  pc.width = P.w; pc.height = P.h;
  const pctx = pc.getContext("2d");
  pctx.putImageData(new ImageData(P.out.data, P.out.w, P.out.h), 0, 0);
  pc.style.width = Math.min(P.w * P.scale, 420) + "px";
  // tile grid overlay (visual aid only — never baked into P.out or downloads)
  let tileInfo = "";
  if (P.grid && P.tile >= 8) {
    pctx.strokeStyle = "rgba(255,255,255,.45)";
    pctx.lineWidth = 1;
    pctx.beginPath();
    for (let gx = P.tile; gx < P.w; gx += P.tile) { pctx.moveTo(gx + .5, 0); pctx.lineTo(gx + .5, P.h); }
    for (let gy = P.tile; gy < P.h; gy += P.tile) { pctx.moveTo(0, gy + .5); pctx.lineTo(P.w, gy + .5); }
    pctx.stroke();
    tileInfo = ` · ${Math.ceil(P.w / P.tile)}×${Math.ceil(P.h / P.tile)} tiles`;
  }
  const tc = $("#pxTileCount");
  if (tc) tc.textContent = tileInfo.replace(" · ", "");

  $("#pxOrigCap").textContent = `original · ${P.imgW} × ${P.imgH}`;
  $("#pxOutCap").textContent = `pixel art · ${P.w} × ${P.h} · ${pxColorLabel(P.colors)}${P.dither ? " · dithered" : ""}${tileInfo} · ${ms}ms`;
  side.hidden = false;
}

function pxDownloadArt() {
  const P = state.pixelart;
  if (!P || !P.out) { stageMsg("Upload an image first.", true); return; }
  const big = pxUpscaleNearest(P.out, 8); // crisp ×8 nearest-neighbor export
  const cv = document.createElement("canvas");
  cv.width = big.w; cv.height = big.h;
  cv.getContext("2d").putImageData(new ImageData(big.data, big.w, big.h), 0, 0);
  downloadCanvas(cv, `m4ster-pixel-art-${P.w}x${P.h}-${P.colors || "full"}c.png`);
}

function wirePixelArt() {
  const P = pxState();
  const clampWH = (v) => Math.max(8, Math.min(1024, Math.round(v) || 64));

  const syncOrigBtn = () => {
    const ob = $("#pxOrigBtn");
    if (ob && P.imgW) ob.textContent = `Original ${P.imgW}×${P.imgH}`;
  };
  syncOrigBtn();

  $("#pxPick").onclick = () => $("#pxFile").click();
  $("#pxFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const cv = document.createElement("canvas");
      cv.width = bmp.width; cv.height = bmp.height;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(bmp, 0, 0);
      const id = cx.getImageData(0, 0, bmp.width, bmp.height);
      P.src = { data: id.data, w: bmp.width, h: bmp.height };
      P.imgW = bmp.width; P.imgH = bmp.height;
      if (bmp.close) bmp.close();
      syncOrigBtn();
      stageMsg(`loaded ${f.name} — ${bmp.width}×${bmp.height}`);
    } catch (err) {
      stageMsg("couldn't read that image — try a PNG or JPG.", true);
      return;
    }
    pxRender();
    e.target.value = "";
  };

  document.querySelectorAll("#pxDims .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#pxDims .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      if (b.id === "pxOrigBtn") {
        if (!P.src) { stageMsg("Upload an image first.", true); return; }
        P.w = clampWH(P.imgW); P.h = clampWH(P.imgH);
      } else {
        P.w = P.h = parseInt(b.dataset.px, 10);
      }
      $("#pxW").value = P.w; $("#pxH").value = P.h;
      pxRender();
    };
  });
  const wh = () => {
    P.w = clampWH(parseInt($("#pxW").value, 10));
    P.h = clampWH(parseInt($("#pxH").value, 10));
    $("#pxW").value = P.w; $("#pxH").value = P.h;
    document.querySelectorAll("#pxDims .seg-btn").forEach(x => x.classList.toggle("active", parseInt(x.dataset.px, 10) === P.w && P.w === P.h));
    pxRender();
  };
  $("#pxW").onchange = wh; $("#pxH").onchange = wh;
  $("#pxColors").onchange = (e) => { P.colors = parseInt(e.target.value, 10); pxRender(); };
  $("#pxDither").onchange = (e) => { P.dither = e.target.checked; pxRender(); };
  $("#pxGrid").onchange = (e) => { P.grid = e.target.checked; pxRender(); };
  $("#pxTile").onchange = (e) => { P.tile = parseInt(e.target.value, 10); pxRender(); };
  $("#pxScale").oninput = (e) => {
    P.scale = parseInt(e.target.value, 10);
    $("#pxScaleVal").textContent = "×" + P.scale;
    const pc = $("#pxOut");
    if (P.out && pc.width) pc.style.width = Math.min(P.w * P.scale, 420) + "px";
  };
  $("#pxDownload").onclick = pxDownloadArt;
  syncPixelMode();
}

/* ================= v6.6: dedicated sprite slicer =================
 * One proper slicer (supersedes the v5 splitter): upload a sheet, see a
 * live grid overlay on the sheet, tune rows/cols/margin/padding/offset,
 * or auto-detect pieces. Click cells in order to pick frames, animated
 * preview, export sheet PNG + manifest JSON.
 *
 * Grid math (Unity-sprite-editor style):
 *   cellW = (W - 2*margin - (cols-1)*pad) / cols
 *   x(c)  = margin + ox + c * (cellW + pad)
 * (same for the rows). Fractional rects are kept until cut time so odd
 * sheet sizes never drop a pixel. */

function detectPieces(img, bg) {
  const w = img.width, h = img.height;
  const data = img.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const isContent = contentTest(data, w, h, bg);
  const visited = new Uint8Array(w * h);
  const comps = [];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (visited[idx] || !isContent(x, y)) continue;
      let x0 = x, x1 = x, y0 = y, y1 = y, area = 0, sx = 0, sy = 0;
      stack.push(idx); visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % w, cy = (cur / w) | 0;
        area++; sx += cx; sy += cy;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        if (cx > 0)     { const n = cur - 1; if (!visited[n] && isContent(cx - 1, cy)) { visited[n] = 1; stack.push(n); } }
        if (cx < w - 1) { const n = cur + 1; if (!visited[n] && isContent(cx + 1, cy)) { visited[n] = 1; stack.push(n); } }
        if (cy > 0)     { const n = cur - w; if (!visited[n] && isContent(cx, cy - 1)) { visited[n] = 1; stack.push(n); } }
        if (cy < h - 1) { const n = cur + w; if (!visited[n] && isContent(cx, cy + 1)) { visited[n] = 1; stack.push(n); } }
      }
      comps.push({ x0, x1, y0, y1, area, cx: sx / area, cy: sy / area });
    }
  }
  let total = 0;
  for (const c of comps) total += c.area;
  if (total === 0) return [];
  const kept = comps.filter(c => c.area >= Math.max(60, total * 0.0015));
  // reading order: group into horizontal bands, sort bands top-down, items left-right
  const bands = [];
  for (const c of kept) {
    const bandH = Math.max(8, (c.y1 - c.y0) / 2);
    let band = bands.find(bd => Math.abs(bd.cy - c.cy) < bandH);
    if (!band) { band = { cy: c.cy, items: [] }; bands.push(band); }
    band.items.push(c);
    band.cy = band.items.reduce((s, i) => s + i.cy, 0) / band.items.length;
  }
  bands.sort((a, b) => a.cy - b.cy);
  const ordered = [];
  for (const b of bands) {
    b.items.sort((a, b2) => a.cx - b2.cx);
    ordered.push(...b.items);
  }
  const pad = 2;
  return ordered.map(c => {
    const x0 = Math.max(0, c.x0 - pad), y0 = Math.max(0, c.y0 - pad);
    const x1 = Math.min(w - 1, c.x1 + pad), y1 = Math.min(h - 1, c.y1 + pad);
    const cell = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
    cell.getContext("2d").drawImage(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, x1 - x0 + 1, y1 - y0 + 1);
    return cell;
  });
}

/* normalize a piece into a shared cell, bottom-centered (stable feet for walk cycles) */
function placeBottomCenter(piece, cw, ch) {
  const cell = makeCanvas(cw, ch);
  const dx = Math.round((cw - piece.width) / 2);
  const dy = Math.max(0, Math.round(ch - piece.height - ch * 0.03));
  cell.getContext("2d").drawImage(piece, dx, dy);
  return cell;
}

/* what counts as ink vs empty background for trim + auto-detect. bg: transparent | black | white (chroma is pre-keyed to transparent) */
function contentTest(data, w, h, bg) {
  if (bg === "black") {
    return (x, y) => {
      const o = (y * w + x) * 4;
      return data[o + 3] > 12 && Math.max(data[o], data[o + 1], data[o + 2]) > 28;
    };
  }
  if (bg === "white") {
    return (x, y) => {
      const o = (y * w + x) * 4;
      return data[o + 3] > 12 && Math.min(data[o], data[o + 1], data[o + 2]) < 227;
    };
  }
  return (x, y) => data[(y * w + x) * 4 + 3] > 12;
}

/* canvas copy */
function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

/* punch the selected background to transparent, in place */
function knockoutBg(canvas, bg) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const isContent = contentTest(img.data, w, h, bg);
  const d = img.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (!isContent(x, y)) d[(y * w + x) * 4 + 3] = 0;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* crop to the content bbox (+2px pad). Returns null when the cell is empty. */
function trimToContent(cell, bg) {
  const w = cell.width, h = cell.height;
  const data = cell.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const isContent = contentTest(data, w, h, bg);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (isContent(x, y)) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  if (x1 < x0) return null;
  const pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext("2d").drawImage(cell, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}

/* even grid rects with margin / padding / offset, row-major order.
 * Pure math — no DOM — so it unit-tests cleanly. */
function slicerGridRects(w, h, rows, cols, o) {
  o = o || {};
  const margin = Math.max(0, +o.margin || 0), pad = Math.max(0, +o.pad || 0);
  const ox = +o.ox || 0, oy = +o.oy || 0;
  rows = Math.max(1, Math.round(rows)); cols = Math.max(1, Math.round(cols));
  const cw = (w - margin * 2 - (cols - 1) * pad) / cols;
  const ch = (h - margin * 2 - (rows - 1) * pad) / rows;
  const rects = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      rects.push({
        x: margin + ox + c * (cw + pad),
        y: margin + oy + r * (ch + pad),
        w: cw, h: ch,
      });
  return rects;
}

/* cut each rect out of the sheet. Start floored, end ceiled (like v5) so
 * coverage is exact and no pixel is ever dropped to rounding. */
function slicerCutCells(sheet, rects) {
  const W = sheet.width, H = sheet.height;
  return rects.map(rc => {
    const x0 = Math.max(0, Math.floor(rc.x)), y0 = Math.max(0, Math.floor(rc.y));
    const x1 = Math.min(W, Math.ceil(rc.x + rc.w)), y1 = Math.min(H, Math.ceil(rc.y + rc.h));
    const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
    const cell = makeCanvas(cw, ch);
    cell.getContext("2d").drawImage(sheet, x0, y0, cw, ch, 0, 0, cw, ch);
    return cell;
  });
}

/* ---------------- slicer state + wiring ---------------- */

function slState() {
  if (!state.slicer) {
    const d = CATEGORY_DEFAULTS.slicer;
    state.slicer = {
      sheet: null, imgW: 0, imgH: 0,
      rows: d.rows, cols: d.cols, mode: d.mode, bg: d.bg, knockout: d.knockout,
      margin: d.margin, pad: d.pad, ox: d.ox, oy: d.oy,
      pieces: [], selection: [],
      fps: d.fps, playback: d.playback,
    };
  }
  return state.slicer;
}

function syncSlicerMode() {
  const on = state.category === "slicer";
  const aside = document.querySelector("aside.controls");
  const stage = document.querySelector("section.stage-panel");
  if (aside) aside.classList.toggle("mode-slicer", on);
  if (stage) stage.classList.toggle("mode-slicer", on);
  document.body.classList.toggle("mode-slicer", on);
  if (!on) {
    // leaving the lane: hide the piece picker (the pipeline owns the stage)
    const grid = $("#splitGrid"), head = $("#splitHead");
    if (grid) grid.hidden = true;
    if (head) head.hidden = true;
  }
}

/* draw the sheet + live grid overlay on the stage canvas */
function slicerOverlay() {
  const S = slState();
  const st = $("#stage");
  if (!st) return;
  if (!S.sheet) { clearStage(); return; }
  st.width = S.imgW; st.height = S.imgH;
  const ctx = st.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(S.sheet, 0, 0);
  const ro = $("#slReadout");
  if (S.mode === "grid") {
    const rects = slicerGridRects(S.imgW, S.imgH, S.rows, S.cols, S);
    let accent = "#f97316";
    try { accent = getComputedStyle(document.documentElement).getPropertyValue("--violet").trim() || accent; } catch (e) {}
    ctx.strokeStyle = accent; ctx.fillStyle = accent;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1, Math.min(S.imgW, S.imgH) / 400);
    const fs = Math.max(10, Math.min(S.imgW, S.imgH) / 24);
    ctx.font = `${fs}px monospace`;
    rects.forEach((rc, i) => {
      ctx.strokeRect(rc.x + 0.5, rc.y + 0.5, Math.max(1, rc.w - 1), Math.max(1, rc.h - 1));
      ctx.fillText(String(i + 1), rc.x + 4, rc.y + fs);
    });
    ctx.globalAlpha = 1;
    if (ro) ro.innerHTML = `sheet <b>${S.imgW} &times; ${S.imgH}</b> &rarr; ${S.rows}&times;${S.cols} = ${rects.length} cells &middot; <b>${Math.round(rects[0].w)} &times; ${Math.round(rects[0].h)} px</b> per cell`;
  } else {
    if (ro) ro.innerHTML = `sheet <b>${S.imgW} &times; ${S.imgH}</b> &middot; auto-detect: <b>${S.pieces.length}</b> piece(s) found`;
  }
  stageMsg("");
}

/* main slice: normalize background -> cut pieces -> number them */
function runSlicer() {
  const S = slState();
  if (!S.sheet) { stageMsg("Upload a sprite sheet first.", true); return; }
  // normalize: chroma -> keyed copy; black/white -> knockout copy (optional);
  // trim + detect then work on plain transparency
  let work = copyCanvas(S.sheet);
  let effBg = S.bg;
  if (S.bg === "chroma") { work = chromaKey(work, state.key); effBg = "transparent"; }
  else if (S.knockout && S.bg !== "transparent") { knockoutBg(work, S.bg); effBg = "transparent"; }

  let pieces;
  if (S.mode === "grid") {
    const rects = slicerGridRects(S.imgW, S.imgH, S.rows, S.cols, S);
    pieces = slicerCutCells(work, rects).map((cell, i) => {
      const t = trimToContent(cell, effBg);
      return { canvas: t, empty: !t, rect: rects[i] };
    });
  } else {
    pieces = detectPieces(work, effBg).map(c => ({ canvas: c, empty: false, rect: null }));
  }
  const usable = pieces.filter(p => !p.empty);
  S.pieces = pieces;
  S.selection = S.selection.filter(i => i < pieces.length && !pieces[i].empty);
  slicerOverlay();
  renderSlicerPieces();
  slicerPreview();
  updateSlicerExport();
  if (!usable.length) {
    stageMsg(`slicer found no usable pieces (sheet ${S.imgW}\u00d7${S.imgH}, grid ${S.rows}\u00d7${S.cols}) — try a different background, or fewer rows/cols.`, true);
    return;
  }
  const empty = pieces.length - usable.length;
  stageMsg(`sliced ${pieces.length} piece(s), ${usable.length} usable${empty ? ` (${empty} empty)` : ""} — click pieces in order`);
}

/* numbered piece picker: click in order, click again to deselect (renumbers) */
function renderSlicerPieces() {
  const S = state.slicer;
  const grid = $("#splitGrid"), head = $("#splitHead");
  const on = !!(S && S.sheet && S.pieces.length);
  if (grid) grid.hidden = !on;
  if (head) head.hidden = !on;
  if (!on || !S) return;
  grid.innerHTML = "";
  $("#splitMeta").textContent = `· ${S.pieces.length} pieces, ${S.selection.length} picked`;
  S.pieces.forEach((p, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "piece-card" + (p.empty ? " empty" : "");
    card.disabled = !!p.empty;
    card.setAttribute("aria-label", `piece ${i + 1}${p.empty ? " (empty)" : ""}`);
    const orderIdx = S.selection.indexOf(i);
    if (orderIdx >= 0) card.classList.add("picked");
    const badges = document.createElement("span");
    badges.innerHTML = `<span class="pnum">${i + 1}</span>` +
      (orderIdx >= 0 ? `<span class="porder">${orderIdx + 1}</span>` : "");
    card.appendChild(badges);
    if (p.canvas) {
      const cv = document.createElement("canvas");
      const sc = Math.min(56 / p.canvas.width, 56 / p.canvas.height, 1);
      cv.width = Math.max(1, Math.round(p.canvas.width * sc));
      cv.height = Math.max(1, Math.round(p.canvas.height * sc));
      cv.getContext("2d").drawImage(p.canvas, 0, 0, cv.width, cv.height);
      card.appendChild(cv);
    } else {
      const em = document.createElement("span");
      em.className = "pempty";
      em.textContent = "—";
      card.appendChild(em);
    }
    card.addEventListener("click", () => slicerPick(i));
    grid.appendChild(card);
  });
}

function slicerPick(i) {
  const S = state.slicer;
  if (!S || S.pieces[i].empty) return;
  const at = S.selection.indexOf(i);
  if (at >= 0) S.selection.splice(at, 1);
  else S.selection.push(i);
  renderSlicerPieces();
  slicerPreview();
  updateSlicerExport();
}

let slicerRAF = 0, slicerT = 0, slicerDir = 1;
function slicerPreview() {
  cancelAnimationFrame(slicerRAF);
  cancelAnimationFrame(previewRAF);
  const S = state.slicer;
  const pc = $("#preview");
  if (!pc) return;
  const pctx = pc.getContext("2d");
  pctx.imageSmoothingEnabled = false;
  const sel = $("#previewState");
  sel.innerHTML = "";
  const o = document.createElement("option");
  o.value = 0; o.textContent = "slice animation";
  sel.appendChild(o);
  sel.disabled = true;
  slicerT = 0; slicerDir = 1;
  pctx.clearRect(0, 0, pc.width, pc.height);
  if (!S || !S.selection.length) {
    $("#previewMeta").textContent = (S && S.sheet) ? "· pick frames above" : "";
    return;
  }
  let last = performance.now();
  function tick(now) {
    slicerRAF = requestAnimationFrame(tick);
    const fr = S.selection.map(j => S.pieces[j].canvas);
    if (!fr.length) return;
    const fps = S.fps || 8;
    if (now - last < 1000 / fps) return;
    last = now;
    if (S.playback === "once") { if (slicerT < fr.length - 1) slicerT++; }
    else if (S.playback === "pingpong") {
      slicerT += slicerDir;
      if (slicerT >= fr.length - 1) { slicerT = fr.length - 1; slicerDir = -1; }
      if (slicerT <= 0) { slicerT = 0; slicerDir = 1; }
    }
    else slicerT = (slicerT + 1) % fr.length;
    let cw = 0, ch = 0;
    for (const f of fr) { cw = Math.max(cw, f.width); ch = Math.max(ch, f.height); }
    const sc = Math.min(pc.width / cw, pc.height / ch, 8);
    const dw = Math.max(1, Math.round(cw * sc)), dh = Math.max(1, Math.round(ch * sc));
    const ox = (pc.width - dw) / 2, oy = (pc.height - dh) / 2;
    pctx.clearRect(0, 0, pc.width, pc.height);
    const f = fr[slicerT];
    const fw = Math.max(1, Math.round(f.width * sc)), fh = Math.max(1, Math.round(f.height * sc));
    pctx.drawImage(f, ox + Math.round((dw - fw) / 2), oy + dh - fh, fw, fh);
    $("#previewMeta").textContent = `· slice · frame ${slicerT + 1}/${fr.length}`;
  }
  tick(last);
}

/* pack ONLY the picked frames into a one-row animation sheet + manifest */
function buildSlicerAtlas() {
  const S = state.slicer;
  const sel = S.selection.map(i => S.pieces[i].canvas);
  if (!sel.length) fail("pick at least one frame first — click pieces in order.");
  let cw = 0, ch = 0;
  for (const f of sel) { cw = Math.max(cw, f.width); ch = Math.max(ch, f.height); }
  const norm = sel.map(f => placeBottomCenter(f, cw, ch));
  const pad = 2;
  const sheet = makeCanvas(cw * norm.length + pad * 2, ch + pad * 2);
  const sctx = sheet.getContext("2d");
  const rects = [];
  norm.forEach((f, i) => {
    const x = pad + i * cw;
    sctx.drawImage(f, x, pad);
    rects.push({ x, y: pad, w: cw, h: ch });
  });
  const manifest = {
    tool: BRAND.tool,
    version: "2.2.0",
    engine: "slicer",
    runRevision: state.revision,
    atlas: "m4ster-split-animation.png",
    sheetWidth: sheet.width,
    sheetHeight: sheet.height,
    sliceSource: {
      mode: S.mode, bg: S.bg, grid: [S.rows, S.cols],
      margin: S.margin, pad: S.pad, offset: [S.ox, S.oy],
      sheetW: S.imgW, sheetH: S.imgH,
    },
    frameLayout: { padding: pad, rows: { anim: { row: 0, cellWidth: cw, cellHeight: ch, rects } } },
    animations: {
      anim: {
        row: 0, frames: norm.length, fps: S.fps, loop: S.playback !== "once",
        playback: S.playback,
        durationsMs: norm.map(() => Math.round(1000 / S.fps)),
        frameOrder: S.selection.slice(),
      },
    },
  };
  return { canvas: sheet, manifest, pngName: "m4ster-split-animation.png", jsonName: "m4ster-split-animation.json" };
}

function updateSlicerExport() {
  const n = state.slicer ? state.slicer.selection.length : 0;
  const on = n > 0;
  ["#slDownload", "#slCells"].forEach(sl => { const el = $(sl); if (el) el.disabled = !on; });
  state.atlas = on ? buildSlicerAtlas() : null;
  slicerOverlay();
}

function slicerDownload() {
  const S = state.slicer;
  if (!S || !S.selection.length) { stageMsg("pick at least one frame first.", true); return; }
  const a = buildSlicerAtlas();
  downloadCanvas(a.canvas, a.pngName);
  setTimeout(() => downloadJSON(a.manifest, a.jsonName), 400);
}

function slicerDownloadCells() {
  const S = state.slicer;
  if (!S || !S.selection.length) return;
  let delay = 0;
  S.selection.forEach((pi, oi) => {
    const c = S.pieces[pi].canvas;
    setTimeout(() => downloadCanvas(c, `m4ster-slice-frame${oi}.png`), delay);
    delay += 350;
  });
}

/* ---------------- slicer control wiring ---------------- */

function wireSlicer() {
  const S = slState();

  $("#slPick").onclick = () => $("#slFile").click();
  $("#slFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const bw = bmp.width, bh = bmp.height; // read BEFORE close(): dims go 0 after
      const cv = makeCanvas(bw, bh);
      cv.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      S.sheet = cv; S.imgW = bw; S.imgH = bh;
      S.pieces = []; S.selection = [];
      stageMsg(`loaded ${f.name} — ${bmp.width}×${bmp.height}, slicing…`);
      runSlicer();
    } catch (err) {
      stageMsg("couldn't read that image — try a PNG or JPG.", true);
    }
    e.target.value = "";
  };

  document.querySelectorAll("#slModeSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#slModeSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      S.mode = b.dataset.mode;
      $("#slGridRow").hidden = S.mode !== "grid";
      runSlicer();
    };
  });

  // sliders: live overlay while dragging, re-slice on release
  const bindRange = (id, valId, key) => {
    const el = $(id);
    el.oninput = () => { S[key] = +el.value; $(valId).textContent = el.value; slicerOverlay(); };
    el.onchange = () => { S[key] = +el.value; runSlicer(); };
  };
  bindRange("#slRows", "#slRowsVal", "rows");
  bindRange("#slCols", "#slColsVal", "cols");

  [["slMargin", "margin"], ["slPad", "pad"], ["slOx", "ox"], ["slOy", "oy"]].forEach(([id, key]) => {
    $(id).onchange = (e) => {
      S[key] = Math.max(0, Math.round(+e.target.value || 0));
      e.target.value = S[key];
      slicerOverlay();
      runSlicer();
    };
  });

  document.querySelectorAll("#slBgSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#slBgSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      S.bg = b.dataset.bg;
      runSlicer();
    };
  });
  $("#slKnockout").onchange = (e) => { S.knockout = e.target.checked; runSlicer(); };

  $("#slFps").onchange = (e) => { S.fps = +e.target.value || 8; slicerT = 0; };
  document.querySelectorAll("#slPlaybackSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#slPlaybackSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      S.playback = b.dataset.playback;
      slicerT = 0; slicerDir = 1;
    };
  });

  $("#slSelectAll").onclick = () => {
    if (!S.pieces.length) return;
    S.selection = S.pieces.map((p, i) => i).filter(i => !S.pieces[i].empty);
    renderSlicerPieces(); slicerPreview(); updateSlicerExport();
  };
  $("#slClear").onclick = () => {
    S.selection = [];
    renderSlicerPieces(); slicerPreview(); updateSlicerExport();
  };
  $("#slReslice").onclick = runSlicer;
  $("#slDownload").onclick = slicerDownload;
  $("#slCells").onclick = slicerDownloadCells;
  syncSlicerMode();
}

/* ================= wiring ================= */

function init() {
  renderParams();
  wireExport();
  syncPixelMode();
  syncSlicerMode();

  document.querySelectorAll(".tab").forEach(t => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      state.category = t.dataset.cat;
      cancelAnimationFrame(slicerRAF);
      renderParams();
      syncPixelMode();
      syncSlicerMode();
      syncAiModelUI();
    };
  });

  document.querySelectorAll("#sourceSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("#sourceSeg .seg-btn").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.source = b.dataset.src;
      syncAiModelUI();
    };
  });

  /* v6.8: AI model switcher wiring */
  try {
    const savedModel = localStorage.getItem(LS_AI_MODEL);
    if (savedModel && AI_PROVIDERS[savedModel]) state.aiModel = savedModel;
  } catch (e) {}
  const aiSel = document.getElementById("aiModel");
  if (aiSel) {
    aiSel.addEventListener("change", () => {
      state.aiModel = aiSel.value;
      try { localStorage.setItem(LS_AI_MODEL, state.aiModel); } catch (e) {}
      syncAiModelUI();
    });
  }
  const aiKeyInput = document.getElementById("aiKey");
  if (aiKeyInput) {
    aiKeyInput.addEventListener("input", () => {
      const p = AI_PROVIDERS[state.aiModel];
      if (!p || !p.keyField) return;
      const keys = aiKeys();
      keys[p.keyField] = aiKeyInput.value.trim();
      try { localStorage.setItem(LS_AI_KEYS, JSON.stringify(keys)); } catch (e) {}
    });
  }
  /* character panel picks are stashed on every change so a tab hop or a
   * gallery open never silently resets the states the user checked */
  const paramsBox = $("#params");
  if (paramsBox) paramsBox.addEventListener("change", () => {
    if (state.category !== "character" || !paramsBox.querySelector("#pFrames")) return;
    state.charStash = {
      states: [...paramsBox.querySelectorAll("#stateRow input:checked")].map(i => i.dataset.state),
      frames: clampInt(paramsBox.querySelector("#pFrames").value, 2, 12, 4),
      archetype: paramsBox.querySelector("#pArch") ? paramsBox.querySelector("#pArch").value : "biped",
      palette: paramsBox.querySelector("#pPal") ? paramsBox.querySelector("#pPal").value : "classic"
    };
  });

  /* v6.9: character animation style (still vs strip) */
  try {
    if (localStorage.getItem("m4ster.aiStyle") === "strip") state.aiStyle = "strip";
  } catch (e) {}
  document.querySelectorAll("#aiStyleSeg .seg-btn").forEach(b => {
    b.onclick = () => {
      state.aiStyle = b.dataset.style;
      try { localStorage.setItem("m4ster.aiStyle", state.aiStyle); } catch (e) {}
      syncAiModelUI();
    };
  });
  syncAiModelUI();

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
    syncAiModelUI();
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
    { id: "ember",     name: "Ember",       swatch: "#f97316" },
    { id: "violet",    name: "Violet dusk", swatch: "#8b5cf6" },
    { id: "midnight",  name: "Midnight",    swatch: "#0c66e4" },
    { id: "ocean",     name: "Ocean",       swatch: "#0ea5e9" },
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

  /* ---------- v6.8: RGB separators (m4ster standard) ---------- */
  var LS_RGB = "m4ster.rgb";
  function readRGB() {
    var d = { enabled: true, speed: 6, breathe: false };
    try {
      var raw = lsGet(LS_RGB);
      if (raw) {
        var p = JSON.parse(raw);
        if (typeof p.enabled === "boolean") d.enabled = p.enabled;
        if (isFinite(p.speed)) d.speed = Math.min(20, Math.max(2, +p.speed));
        if (typeof p.breathe === "boolean") d.breathe = p.breathe;
      }
    } catch (e) {}
    return d;
  }
  function applyRGB() {
    var r = readRGB();
    document.body.classList.toggle("no-rgb", !r.enabled);
    document.body.classList.toggle("rgb-breathe", r.breathe);
    document.documentElement.style.setProperty("--rgb-speed", r.speed + "s");
    var tg = document.getElementById("rgbToggle");
    if (tg) tg.setAttribute("aria-checked", r.enabled ? "true" : "false");
    var sp = document.getElementById("rgbSpeed");
    if (sp) sp.value = String(r.speed);
    var br = document.getElementById("rgbBreathe");
    if (br) br.setAttribute("aria-checked", r.breathe ? "true" : "false");
  }
  function saveRGB(patch) {
    var r = readRGB();
    for (var k in patch) r[k] = patch[k];
    lsSet(LS_RGB, JSON.stringify(r));
    applyRGB();
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
    document.getElementById("rgbToggle").addEventListener("click", function () {
      saveRGB({ enabled: !readRGB().enabled });
    });
    document.getElementById("rgbSpeed").addEventListener("input", function (e) {
      saveRGB({ speed: +e.target.value });
    });
    document.getElementById("rgbBreathe").addEventListener("click", function () {
      saveRGB({ breathe: !readRGB().breathe });
    });
    document.getElementById("custSave").addEventListener("click", function () {
      /* all settings already persist on change — this force-saves the full
       * snapshot (theme + aura + rgb) and confirms visually */
      try {
        lsSet(LS_THEME, document.documentElement.getAttribute("data-theme") || "ember");
        saveAura(readAura());
        saveRGB(readRGB());
      } catch (e) {}
      var tick = document.getElementById("saveTick");
      if (tick) {
        tick.classList.add("show");
        setTimeout(function () { tick.classList.remove("show"); }, 1400);
      }
    });

    applyTheme(lsGet(LS_THEME) || "ember", false);
    applyAura();
    applyRGB();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCustomize);
  } else {
    initCustomize();
  }
})();

/* ================= v6 "THE MIXTURE" =================
 * Seele: prompt-first hero + category cards. Ludo: animated gallery cards,
 * motion presets, export bundle (PNG + GIF + JSON). PixelLab: pixel-art
 * polish (facing flip). Design refs: scroll-reveal entrances, living
 * background parallax, responsive type scale, focus-visible polish.
 * Everything below is additive — v1-v5 behavior is untouched. */

const BRAND = {
  name: "m4ster FrameLab",
  tool: "m4ster-framelab",
  tagline: "For the gamers, by the gamers",
};

state.flipX = false;         // character facing: false = right, true = left (non-destructive view)
/* (v6.6: slicer playback lives on state.slicer.fps/.playback; slicerT/slicerDir below) */

/* ---------- facing flip: non-destructive view transform, like curation ---------- */
function drawFrameAt(ctx, frame, x, y) {
  if (!state.flipX) { ctx.drawImage(frame, x, y); return; }
  ctx.save();
  ctx.translate(x + frame.width, y);
  ctx.scale(-1, 1);
  ctx.drawImage(frame, 0, 0);
  ctx.restore();
}

function flippedCopy(c) {
  const o = makeCanvas(c.width, c.height);
  const x = o.getContext("2d");
  x.translate(c.width, 0); x.scale(-1, 1);
  x.drawImage(c, 0, 0);
  return o;
}

/* ---------- GIF encoder (export bundle) ----------
 * Minimal GIF89a writer: global 256-color table (index 0 = transparent),
 * per-frame GCE + LZW image data, NETSCAPE infinite loop. Pixel art
 * compresses well; frames are normalized bottom-center before encoding. */
function downloadBytes(u8, filename, mime) {
  const blob = new Blob([u8], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, nextCode = eoi + 1;
  const dict = new Map();
  const out = [];
  let buf = 0, bits = 0;
  const emit = (code) => {
    buf |= code << bits; bits += codeSize;
    while (bits >= 8) { out.push(buf & 255); buf >>= 8; bits -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 256 + k;
    if (dict.has(key)) { prefix = dict.get(key); continue; }
    emit(prefix);
    if (nextCode < 4096) {
      dict.set(key, nextCode++);
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear); dict.clear(); nextCode = eoi + 1; codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) out.push(buf & 255);
  const blocks = [];
  for (let i = 0; i < out.length; i += 255) blocks.push(out.slice(i, Math.min(i + 255, out.length)));
  return blocks;
}

function encodeGIF(frames, fps) {
  if (!frames.length) fail("no frames to encode");
  const src = frames.map(f => state.flipX ? flippedCopy(f) : f);
  let W = 0, H = 0;
  for (const f of src) { W = Math.max(W, f.width); H = Math.max(H, f.height); }
  W = Math.min(512, W); H = Math.min(512, H);
  const norm = src.map(f => {
    const c = makeCanvas(W, H);
    const x = c.getContext("2d");
    const s = Math.min(W / f.width, H / f.height, 1);
    const dw = Math.max(1, Math.round(f.width * s)), dh = Math.max(1, Math.round(f.height * s));
    x.imageSmoothingEnabled = false;
    x.drawImage(f, Math.round((W - dw) / 2), H - dh, dw, dh); // bottom-center: stable feet
    return x.getImageData(0, 0, W, H).data;
  });
  // palette: index 0 = transparent, then the 255 most-frequent colors
  const freq = new Map();
  for (const px of norm) {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] <= 12) continue;
      const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
      freq.set(key, (freq.get(key) || 0) + 1);
    }
  }
  const colors = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 255).map(e => e[0]);
  const table = new Uint8Array(256 * 3);
  const lut = new Map();
  colors.forEach((c, i) => {
    lut.set(c, i + 1);
    table[(i + 1) * 3] = (c >> 16) & 255;
    table[(i + 1) * 3 + 1] = (c >> 8) & 255;
    table[(i + 1) * 3 + 2] = c & 255;
  });
  const nearest = (r, g, b) => {
    let best = 1, bd = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const dr = r - ((c >> 16) & 255), dg = g - ((c >> 8) & 255), db = b - (c & 255);
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i + 1; }
    }
    return best;
  };
  const bytes = [];
  const pushStr = s => { for (const ch of s) bytes.push(ch.charCodeAt(0)); };
  const w16 = n => bytes.push(n & 255, (n >> 8) & 255);
  pushStr("GIF89a");
  w16(W); w16(H);
  bytes.push(0xF7, 0, 0); // GCT flag + 8-bit resolution + 256-entry table
  for (const b of table) bytes.push(b);
  bytes.push(0x21, 0xFF, 0x0B); // NETSCAPE infinite loop
  pushStr("NETSCAPE2.0");
  bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);
  const delay = Math.max(2, Math.round(100 / (fps || 8)));
  for (const px of norm) {
    const idx = new Array(W * H);
    for (let p = 0, i = 0; p < px.length; p += 4, i++) {
      if (px[p + 3] <= 12) { idx[i] = 0; continue; }
      const key = (px[p] << 16) | (px[p + 1] << 8) | px[p + 2];
      idx[i] = lut.has(key) ? lut.get(key) : nearest(px[p], px[p + 1], px[p + 2]);
    }
    bytes.push(0x21, 0xF9, 0x04, 0x09, delay & 255, (delay >> 8) & 255, 0x00, 0x00); // GCE: disposal 2, transparent idx 0
    bytes.push(0x2C, 0x00, 0x00, 0x00, 0x00);
    w16(W); w16(H);
    bytes.push(0x00, 0x08); // no local table, LZW min code size 8
    for (const blk of lzwEncode(idx, 8)) { bytes.push(blk.length); for (const b of blk) bytes.push(b); }
    bytes.push(0x00);
  }
  bytes.push(0x3B);
  return new Uint8Array(bytes);
}

/* ---------- animated gallery (Ludo card anatomy: moving preview,
 * STYLE · FRAME COUNT label, prompt underneath, click opens it in the lab) ---------- */
function sliceStrip(strip, count) {
  const fw = Math.max(1, Math.round(strip.width / count));
  const out = [];
  for (let i = 0; i < count; i++) {
    const c = makeCanvas(fw, strip.height);
    c.getContext("2d").drawImage(strip, i * fw, 0, fw, strip.height, 0, 0, fw, strip.height);
    out.push(c);
  }
  return out;
}

const GALLERY = [
  { style: "PIXEL HERO", n: 4, prompt: "pixel hero walk cycle, side view",
    build: () => sliceStrip(procCharacter({ archetype: "biped", palette: "classic", frames: 4 }, "walk", 4242), 4),
    gen: { cat: "character", src: "procedural", states: ["walk"], frames: 4, archetype: "biped" } },
  { style: "ROBOT", n: 4, prompt: "idle robot, blinking visor",
    build: () => sliceStrip(procCharacter({ archetype: "robot", palette: "classic", frames: 4 }, "idle", 777), 4),
    gen: { cat: "character", src: "procedural", states: ["idle"], frames: 4, archetype: "robot" } },
  { style: "SLIME", n: 4, prompt: "slime hop, squash and stretch",
    build: () => sliceStrip(procCharacter({ archetype: "slime", palette: "toxic", frames: 4 }, "jump", 31337), 4),
    gen: { cat: "character", src: "procedural", states: ["jump"], frames: 4, archetype: "slime" } },
  { style: "FLYER", n: 4, prompt: "bird flapping, side view",
    build: () => sliceStrip(procCharacter({ archetype: "flyer", palette: "classic", frames: 4 }, "walk", 9001), 4),
    gen: { cat: "character", src: "procedural", states: ["walk"], frames: 4, archetype: "flyer" } },
  { style: "EFFECT", n: 8, prompt: "fiery explosion, ignition to smoke",
    build: () => sliceStrip(procEffect("explosion", 8, 555), 8),
    gen: { cat: "effect", src: "procedural", type: "explosion", frames: 8 } },
  { style: "EFFECT", n: 8, prompt: "campfire flames, seamless loop",
    build: () => sliceStrip(procEffect("fire", 8, 888), 8),
    gen: { cat: "effect", src: "procedural", type: "fire", frames: 8 } },
  { style: "UI", n: 4, prompt: "spinning gold coin",
    build: () => sliceStrip(procUI("coin", 4, 1212), 4),
    gen: { cat: "ui", src: "procedural", kind: "coin", states: 4 } },
  { style: "TILE", n: 2, prompt: "animated water tile",
    build: () => procTile("water", 64, 3434),
    gen: { cat: "tile", src: "procedural", pattern: "water", size: 64 } },
];

/* one shared rAF drives every showcase canvas (gallery + presets) — cheaper
 * than a loop per card, paused when the tab hides or reduced-motion is on. */
const showcaseAnims = [];
let showcaseRAF = 0;
const reduceMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

function drawShowcaseFrame(a) {
  const ctx = a.cv.getContext("2d");
  const f = a.frames[a.idx % a.frames.length];
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, a.cv.width, a.cv.height);
  const s = Math.min(a.cv.width / f.width, a.cv.height / f.height);
  const dw = Math.max(1, Math.floor(f.width * s)), dh = Math.max(1, Math.floor(f.height * s));
  ctx.drawImage(f, Math.floor((a.cv.width - dw) / 2), Math.floor((a.cv.height - dh) / 2), dw, dh);
}

function showcaseAdd(cv, frames, fps) {
  const a = { cv, frames, fps: fps || 8, idx: 0, last: 0 };
  drawShowcaseFrame(a);
  showcaseAnims.push(a);
}

function showcaseLoop(now) {
  showcaseRAF = requestAnimationFrame(showcaseLoop);
  for (const a of showcaseAnims) {
    if (now - a.last < 1000 / a.fps) continue;
    a.last = now;
    a.idx = (a.idx + 1) % a.frames.length;
    drawShowcaseFrame(a);
  }
}

function showcaseStart() {
  if (reduceMotion() || showcaseRAF) return;
  showcaseRAF = requestAnimationFrame(showcaseLoop);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { cancelAnimationFrame(showcaseRAF); showcaseRAF = 0; }
  else showcaseStart();
});

function renderGallery() {
  const grid = $("#galleryGrid");
  if (!grid) return;
  grid.innerHTML = "";
  GALLERY.forEach((g, gi) => {
    const card = document.createElement("article");
    card.className = "gcard reveal";
    card.style.setProperty("--d", ((gi % 4) * 0.07).toFixed(2) + "s");
    const cv = document.createElement("canvas");
    cv.width = 160; cv.height = 160;
    cv.className = "gcanvas";
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", g.style + " animation preview");
    const lab = document.createElement("div");
    lab.className = "glabel";
    const b = document.createElement("b"); b.textContent = g.style;
    const sp = document.createElement("span"); sp.textContent = ` · ${g.n} FRAMES`;
    lab.append(b, sp);
    const pr = document.createElement("p");
    pr.className = "gprompt";
    pr.textContent = "\u201C" + g.prompt + "\u201D";
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "gopen";
    btn.textContent = "Open in lab \u2192";
    btn.setAttribute("aria-label", `Open ${g.prompt} in the lab`);
    btn.onclick = () => applyGalleryConfig(g);
    card.append(cv, lab, pr, btn);
    grid.appendChild(card);
    try {
      const frames = g.build();
      if (frames.length) showcaseAdd(cv, frames, g.n > 4 ? 10 : 8);
    } catch (e) { /* one broken card never breaks the page */ }
  });
}

function applyGalleryConfig(item) {
  const g = item.gen || {};
  const tab = document.querySelector(`.tab[data-cat="${g.cat}"]`);
  if (tab) tab.click(); // re-renders params to defaults
  if (g.src && g.src !== "upload") {
    const srcBtn = document.querySelector(`#sourceSeg .seg-btn[data-src="${g.src}"]`);
    if (srcBtn) srcBtn.click();
  }
  if (g.cat === "character") {
    document.querySelectorAll("#stateRow input").forEach(i => { i.checked = (g.states || []).includes(i.dataset.state); });
    if (g.frames) $("#pFrames").value = g.frames;
    if (g.archetype) $("#pArch").value = g.archetype;
  } else if (g.cat === "effect") {
    if (g.type) $("#pType").value = g.type;
    if (g.frames) $("#pFrames").value = g.frames;
  } else if (g.cat === "tile") {
    if (g.pattern) $("#pPattern").value = g.pattern;
    if (g.size) $("#pSize").value = String(g.size);
  } else if (g.cat === "ui") {
    if (g.kind) $("#pKind").value = g.kind;
    if (g.states) $("#pStates").value = g.states;
  }
  if (item.prompt) $("#prompt").value = item.prompt;
  document.getElementById("tool").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => { if (!state.busy) runPipeline(); }, 450);
}

/* ---------- motion presets (Ludo pattern): named motions with live previews.
 * Clicking one drives procedural characters (sets the state + regenerates)
 * or split animations (sets fps + playback mode). ---------- */
const MOTION_PRESETS = [
  { id: "idle",   label: "Idle",   fps: 6,  playback: "pingpong" },
  { id: "walk",   label: "Walk",   fps: 8,  playback: "loop" },
  { id: "run",    label: "Run",    fps: 10, playback: "loop" },
  { id: "jump",   label: "Jump",   fps: 8,  playback: "once" },
  { id: "attack", label: "Attack", fps: 10, playback: "once" },
];

function renderPresets() {
  const row = $("#presetRow");
  if (!row) return;
  row.innerHTML = "";
  MOTION_PRESETS.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-chip reveal";
    btn.dataset.preset = p.id;
    btn.style.setProperty("--d", (i * 0.05).toFixed(2) + "s");
    btn.setAttribute("aria-label", `Apply ${p.label} motion, ${p.fps} frames per second`);
    const cv = document.createElement("canvas");
    cv.width = 64; cv.height = 64; cv.className = "pcanvas";
    cv.setAttribute("aria-hidden", "true");
    const lb = document.createElement("span");
    lb.className = "plabel";
    lb.innerHTML = `${p.label}<small>${p.fps}fps</small>`;
    btn.append(cv, lb);
    btn.onclick = () => applyPreset(p);
    row.appendChild(btn);
    try {
      const frames = sliceStrip(procCharacter({ archetype: "biped", palette: "classic", frames: 4 }, p.id, 20240 + i), 4);
      showcaseAdd(cv, frames, p.fps);
    } catch (e) { /* never break the page */ }
  });
}

function applyPreset(p) {
  document.querySelectorAll(".preset-chip").forEach(c => c.classList.toggle("active", c.dataset.preset === p.id));
  if (state.slicer && state.slicer.sheet && state.slicer.pieces.length) {
    state.slicer.fps = p.fps; state.slicer.playback = p.playback;
    slicerT = 0; slicerDir = 1;
    const fs = $("#slFps"); if (fs) fs.value = String(p.fps);
    document.querySelectorAll("#slPlaybackSeg .seg-btn").forEach(x => x.classList.toggle("active", x.dataset.playback === p.playback));
    slicerPreview();
    stageMsg(`preset "${p.label}" → slice playback: ${p.fps}fps, ${p.playback}`);
    return;
  }
  if (state.category === "character") {
    const boxes = document.querySelectorAll("#stateRow input");
    if (!boxes.length) return;
    boxes.forEach(i => { i.checked = i.dataset.state === p.id; });
    const fsel = $("#previewFps");
    if (fsel) fsel.value = String(p.fps);
    document.getElementById("tool").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => { if (!state.busy) runPipeline(); }, 450);
  } else {
    stageMsg(`preset "${p.label}" drives characters + split animations — switch to the Character tab or upload a sheet.`, "warn");
  }
}

/* ---------- export bundle: PNG + GIF + JSON in one click ---------- */
function currentExportFrames() {
  if (state.slicer && state.slicer.selection.length) return state.slicer.selection.map(i => state.slicer.pieces[i].canvas);
  const r = state.rows[previewRow];
  return r ? r.order.map(fi => r.frames[fi]) : [];
}

function currentExportFps() {
  if (state.slicer && state.slicer.sheet && state.slicer.fps) return state.slicer.fps;
  const sel = +((($("#previewFps") || {}).value) || 8);
  const r = state.rows[previewRow];
  return (r && r.fps) || sel;
}

function initV6() {
  renderGallery();
  renderPresets();
  showcaseStart();

  /* logo = home: clicking the brand mark returns to the top (hero, first screen) */
  const brandHome = document.getElementById("brandHome");
  if (brandHome) {
    brandHome.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
    });
  }

  /* prompt-first hero: type, hit MAKE IT, land in the lab generating */
  const heroGo = () => {
    const hp = $("#heroPrompt");
    const t = hp ? hp.value.trim() : "";
    if (t) $("#prompt").value = t;
    const tool = document.getElementById("tool");
    if (tool) tool.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => { if (!state.busy) runPipeline(); }, 450);
  };
  const heroBtn = $("#heroGenerate"), heroPrompt = $("#heroPrompt");
  if (heroBtn) heroBtn.onclick = heroGo;
  if (heroPrompt) heroPrompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) heroGo();
  });

  /* category cards: pick a lane, land in the lab */
  document.querySelectorAll(".cat-card").forEach(c => {
    c.onclick = () => {
      const cat = c.dataset.cat;
      const tab = document.querySelector(`.tab[data-cat="${cat}"]`);
      if (tab) tab.click();
      document.getElementById("tool").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });

  /* facing flip (delegated: renderParams re-renders #params on tab switch) */
  const paramsBox = $("#params");
  if (paramsBox) paramsBox.addEventListener("click", (e) => {
    const b = e.target.closest("[data-flip]");
    if (!b) return;
    document.querySelectorAll("#pFlipSeg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
    state.flipX = b.dataset.flip === "1";
    if (state.rows.length && state.atlas) {
      state.atlas = buildAtlas(state.rows);
      renderFramesUI();
      startPreview();
      showStage(state.atlas.canvas, "atlas rebuilt — facing " + (state.flipX ? "left" : "right"));
    } else if (state.slicer && state.slicer.sheet) {
      slicerPreview();
      updateSlicerExport();
    }
  });

  /* one-click bundle: sheet PNG + animated GIF preview + manifest JSON.
   * v6.1: staggered ~400ms apart so no download gets swallowed by the browser. */
  const dlBundle = $("#dlBundle");
  if (dlBundle) dlBundle.onclick = () => {
    if (!state.atlas) return;
    const frames = currentExportFrames();
    const fps = currentExportFps();
    downloadCanvas(state.atlas.canvas, state.atlas.pngName); // t+0: PNG sheet
    if (frames.length) {
      setTimeout(() => {
        try {
          const gif = encodeGIF(frames, fps);
          downloadBytes(gif, state.atlas.pngName.replace(/\.png$/, "") + "-preview.gif", "image/gif");
        } catch (e) { stageMsg("GIF encode failed: " + e.message, true); }
      }, 400); // t+400: animated GIF
    }
    setTimeout(() => downloadJSON(state.atlas.manifest, state.atlas.jsonName), 800); // t+800: manifest JSON
  };

/* ---------- v6.1: scroll-reveal entrances, progressive-enhanced.
 * Default state is VISIBLE — .reveal only hides when JS adds .js to <html>,
 * and the observer flips .in. If the observer never fires, content still shows.
 * Observes EVERY .reveal/.reveal-pop (gallery cards + preset chips included —
 * v6 left them unobserved and they never painted). */
const REVEAL_SELECTOR = ".reveal, .reveal-pop";
function initReveals(doc) {
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }
  }, { threshold: 0.1 });
  doc.querySelectorAll(REVEAL_SELECTOR).forEach((el, i) => {
    if (!el.style.getPropertyValue("--d")) {
      el.style.setProperty("--d", Math.min(0.45, (i % 7) * 0.06).toFixed(2) + "s");
    }
    io.observe(el);
  });
  return io;
}

/* entrance choreography: hero + category cards pop, everything else rises */
function initEntrances(doc) {
  doc.querySelectorAll(".hero-inner, .cat-card").forEach(el => el.classList.add("reveal-pop"));
  doc.querySelectorAll(".section-title, #tool .panel, .foot > span").forEach(el => {
    if (!el.classList.contains("reveal") && !el.classList.contains("reveal-pop")) el.classList.add("reveal");
  });
  return initReveals(doc);
}

  /* entrance choreography: hero + category cards pop, everything else rises */
  initEntrances(document);

  /* living background: scroll parallax on the aura (transform-only, cheap) */
  const aura = $("#aura");
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking || reduceMotion() || !aura) return;
    ticking = true;
    requestAnimationFrame(() => {
      aura.style.transform = `translate3d(0, ${Math.round(window.scrollY * 0.06)}px, 0)`;
      ticking = false;
    });
  }, { passive: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initV6);
} else {
  initV6();
}

/* ---------- v6.5: m4ster signature cursor (orb) + aura parallax ----------
 * Desktop/fine-pointer only; skipped entirely on touch + reduced-motion.
 * Orb glow is theme-accent via CSS (--violet). Download/export/generate
 * CTAs trigger the signature pulse-ring state. */
(function () {
  "use strict";
  if (!window.matchMedia) return;
  var fine = window.matchMedia("(pointer: fine)").matches;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!fine || reduced) return;

  var orb = document.createElement("div");
  orb.className = "cursor-orb";
  orb.setAttribute("aria-hidden", "true");
  document.body.appendChild(orb);
  document.documentElement.classList.add("has-orb");

  /* v6.8: cursor glow trail (5IN1 GridGlow idea) — canvas overlay paints
   * fading theme-colored glow spots where the cursor travels. */
  var trail = document.createElement("canvas");
  trail.id = "cursor-trail";
  trail.setAttribute("aria-hidden", "true");
  document.body.appendChild(trail);
  var tctx = trail.getContext("2d");
  var spots = [];
  var TR_LIFE = 900, TR_MAX = 50, TR_GAP = 18, trLast = 0;
  function sizeTrail() {
    trail.width = Math.max(1, window.innerWidth);
    trail.height = Math.max(1, window.innerHeight);
  }
  sizeTrail();
  window.addEventListener("resize", sizeTrail);
  var themeGlow = "167,139,250"; /* violet default; updated per theme */
  function drawTrail(now) {
    tctx.clearRect(0, 0, trail.width, trail.height);
    for (var i = spots.length - 1; i >= 0; i--) {
      var s = spots[i], age = now - s.born;
      if (age > TR_LIFE) { spots.splice(i, 1); continue; }
      var k = 1 - age / TR_LIFE, r = 90 * (0.5 + 0.5 * k);
      var g = tctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      g.addColorStop(0, "rgba(" + themeGlow + "," + (0.28 * k).toFixed(3) + ")");
      g.addColorStop(1, "rgba(" + themeGlow + ",0)");
      tctx.fillStyle = g;
      tctx.beginPath(); tctx.arc(s.x, s.y, r, 0, 6.2832); tctx.fill();
    }
  }

  var tx = -100, ty = -100, x = -100, y = -100; /* target / lerped orb pos */
  /* page runs at 115% CSS zoom: mouse client coords are viewport space but the
   * orb lives inside the zoomed document, so divide by the effective zoom to
   * land the orb exactly on the pointer (else it drifts down-right). */
  var Z = 1;
  function measureZoom() {
    /* getBoundingClientRect on <html> can't reveal CSS zoom (root always
     * matches the viewport) — use a 100px probe div: its rendered width
     * IS affected by the inherited zoom */
    try {
      var d = document.createElement("div");
      d.style.cssText = "position:absolute;left:0;top:0;width:100px;height:10px;visibility:hidden;pointer-events:none;";
      document.body.appendChild(d);
      var z = d.getBoundingClientRect().width / 100;
      d.remove();
      if (z > 0.5 && z < 4) Z = z;
    } catch (e) {}
  }
  measureZoom();
  window.addEventListener("resize", measureZoom);
  var ax = 0, ay = 0;                            /* lerped aura parallax -1..1 */
  var HOVER = "a, button, input, select, textarea, .gcard, .cat-card, .preset-chip, " +
              ".swatch, .tab, .seg-btn, .stepper li, .icon-btn, .frame-card, " +
              ".key, label, summary, [role=button]";
  var CTA = "#dlBundle, #dlSheet, #dlJson, #dlFrames, #dlAnim, #dlGodot, #dlUnity, " +
            "#generate, #heroGenerate, #generateMobile";

  document.addEventListener("mousemove", function (e) {
    tx = e.clientX / Z; ty = e.clientY / Z;
    var now = performance.now();
    if (now - trLast >= TR_GAP) {
      trLast = now;
      spots.push({ x: e.clientX, y: e.clientY, born: now });
      if (spots.length > TR_MAX) spots.splice(0, spots.length - TR_MAX);
    }
  }, { passive: true });
  document.addEventListener("mouseout", function (e) {
    if (!e.relatedTarget) orb.style.opacity = "0";
  });
  document.addEventListener("mouseover", function (e) {
    if (orb.style.opacity === "0") orb.style.opacity = "";
  });

  function closest(el, sel) {
    while (el && el !== document.documentElement) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentNode;
    }
    return null;
  }

  document.addEventListener("mouseover", function (e) {
    var cta = closest(e.target, CTA);
    var hov = cta || closest(e.target, HOVER);
    orb.classList.toggle("is-cta", !!(cta && !cta.disabled));
    orb.classList.toggle("is-hover", !!(hov && !hov.disabled && !(cta && !cta.disabled)));
  }, { passive: true });

  var auraEl = document.getElementById("aura");
  var lastT = "", lastA = "";
  (function tick() {
    /* tight follow (was 0.22 — felt floaty) + snap when converged, so the
     * loop writes nothing once the orb settles instead of micro-lerping */
    var dx = tx - x, dy = ty - y;
    if (dx * dx + dy * dy < 0.01) { x = tx; y = ty; }
    else { x += dx * 0.45; y += dy * 0.45; }
    var k = x.toFixed(1) + "," + y.toFixed(1);
    if (k !== lastT) {
      orb.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0)";
      lastT = k;
    }
    /* aura parallax: direct composited transform on the aura layer, written
     * only when it changed — the old :root var write forced a full style
     * recalc every frame, which was the jank */
    var nx = (tx / window.innerWidth - 0.5) * 2;
    var ny = (ty / window.innerHeight - 0.5) * 2;
    ax += (nx - ax) * 0.08; ay += (ny - ay) * 0.08;
    var ak = (ax * 1.5).toFixed(2) + "," + (ay * 1.5).toFixed(2);
    if (ak !== lastA && auraEl) {
      auraEl.style.transform = "translate3d(" + (ax * 1.5).toFixed(2) + "vmax," + (ay * 1.5).toFixed(2) + "vmax,0)";
      lastA = ak;
    }
    /* cursor glow trail (5IN1 GridGlow): fading spots, drawn only while moving */
    if (spots.length) drawTrail(performance.now());
    else if (trail.width) tctx.clearRect(0, 0, trail.width, trail.height);
    requestAnimationFrame(tick);
  })();
})();

/* v6.9: PWA — register SW, Install App button (Download section only).
 * Button shows on beforeinstallprompt, hides after install or 6s timeout,
 * and never shows when already running as installed PWA (standalone). */
(function () {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
  var btn = document.getElementById("installApp");
  if (!btn) return;
  var isStandalone = window.matchMedia("(display-mode: standalone)").matches ||
                     window.navigator.standalone === true;
  if (isStandalone) return; /* installed — already fullscreen, no button */
  var deferred = null, hideTimer = null;
  function hide() { btn.hidden = true; if (hideTimer) clearTimeout(hideTimer); }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
    hideTimer = setTimeout(hide, 6000); /* auto-hide if ignored */
  });
  btn.addEventListener("click", function () {
    if (!deferred) { hide(); return; }
    deferred.prompt();
    deferred.userChoice.then(function () { hide(); deferred = null; });
  });
  window.addEventListener("appinstalled", hide);
})();
