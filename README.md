# m4ster FrameLab

**For the gamers, by the gamers.**

Free, open-source, unlimited 2D game sprite studio that runs 100% in your
browser. No API keys, no signup, no credit card, no payments — ever.
(The repo and URL stay `m4ster-sprite-gen`; the product brand is FrameLab.)

Type what you want in the big prompt box and hit **MAKE IT** — or pick a
category card, a motion preset, or a gallery piece. You get a packed sprite
sheet PNG plus an atlas manifest JSON your game can read directly.

## v6.8 — AI model switcher

Swap the image model like you swap models in a chat app. Every provider
honours one contract — prompt + size in, one image out — and declares what
it needs up front; a model that can't run says so instead of quietly
downgrading you.

- **Free, no key** — Pollinations · Sana (fast drafts), AI Horde ·
  Deliberate / Juggernaut XL / Stable Diffusion (community GPUs, real
  model choice, queue-based)
- **Free key, paste once** — Pollinations · FLUX (key from
  enter.pollinations.ai), Hugging Face · FLUX.1 schnell (free HF token)
- **Your key, pay per image** — OpenRouter · Gemini Flash Image
  (~1¢/image, billed to your own key, labelled in the UI)

Keys are stored only in your browser's localStorage and are sent only to
the provider you picked. NVIDIA NIM was evaluated and skipped: its image
endpoint sends no CORS headers, so a browser app can't call it directly.

## v6.6 — dedicated sprite Slicer

The sheet slicer is now a first-class lane, not a buried panel — Unity
sprite-editor style, 100% offline:

- **Live grid overlay** — upload a sheet and see the cut lines drawn right
  on it: numbered cells, cell-size readout (e.g. "80 × 110 px per cell").
  Rows/cols sliders (1–32) redraw the overlay live as you drag.
- **Margin / padding / offset** — sheet borders and cell spacing, like a
  real sprite editor.
- **Auto-detect** — content-based blob detection as the alternative to grid.
- **Numbered piece picker** — click cells in order (order badges, click
  again to deselect and renumber). Empty cells are flagged, not clickable.
- **Animated preview** — picked frames play with fps + loop / once /
  ping-pong, bottom-aligned so walk cycles don't jitter.
- **Background knockout** — alpha, black, white, or your chroma key counts
  as "empty"; optional knockout punches it to transparent.
- **Export** — one button: animation sheet PNG + manifest JSON (v2.2.0,
  `engine: "slicer"`); individual cell PNGs too.

## v6.5 — image → pixel art converter

Upload any image and convert it to pixel art at the dimensions you choose —
side-by-side original vs pixel art, exactly like the reference. 100% offline,
zero dependencies, your image never leaves the browser.

- **Output sizes** — presets 16 / 32 / 48 / 64 / 96 / 128px, or custom W×H (8–256).
- **Color control** — 2 / 4 / 8 / 16 / 32 / 256 colors via median-cut quantization, or full color.
- **Floyd–Steinberg dithering** toggle for smooth gradients at low color counts.
- **Transparency preserved** — alpha is never quantized; transparent stays transparent.
- **Crisp preview** — nearest-neighbor upscale only, never blurry; adjustable ×2–×16.
- **One-button export** — pixel-art PNG at a crisp ×8 nearest-neighbor upscale.

## v6.1 — "ALIVE" + reveal fix

- **Fixed: gallery + preset chips now paint.** The v6 scroll-reveal never
  observed the gallery cards or motion preset chips, leaving them stuck at
  `opacity: 0` (blank void under "Fresh from the lab"). The reveal system is
  now progressive-enhanced: default state is visible, reveal only *adds*
  animation — if the observer never fires, content still shows.
- **Living logo** — the pixel M4 mark breathes: glow pulse + gentle float,
  CSS-only (transform/opacity), synced to the aura's calm rhythm. Rests
  under `prefers-reduced-motion`.
- **Entrance choreography** — hero pops in, category cards stagger-pop,
  gallery cards cascade. All under 600ms, skipped under
  `prefers-reduced-motion`.
- **Export bundle stagger** — PNG → GIF → JSON now fire ~400ms apart so
  the browser can't swallow any of the three downloads.

## v6 — "THE MIXTURE"

The best of every competitor, integrated into one app — no login, no
paywall, everything below free forever:

- **Prompt-first hero** — one big "What will you make today?" prompt box
  (Seele's pattern, minus their login wall). Type → MAKE IT → the lab
  generates.
- **Category cards** — Character / Tile / Effect / UI / Splitter as visual
  cards under the hero. One tap picks a lane and drops you in the lab.
- **Animated gallery** — "Fresh from the lab": moving animated preview
  cards (Ludo's card anatomy: moving preview, STYLE · FRAME COUNT, prompt
  underneath). Every card is a live procedural render — click one to open
  that exact setup in the lab.
- **Motion presets** — idle / walk / run / jump / attack with tiny live
  animated previews. One click drives procedural characters (sets the state
  and regenerates) or split animations (sets fps + playback mode:
  loop / once / ping-pong).
- **Export bundle** — one button downloads **sprite-sheet PNG + animated
  GIF preview + manifest JSON** (v2.2.0). Individual PNG/JSON/frames
  buttons remain.
- **Facing flip** — character direction toggle (→ right / ← left), applied
  to preview, atlas, frames, and GIF — non-destructive, like curation.
- **Living UI** — scroll-reveal entrances, scroll parallax on the
  background aura, responsive display type, focus-visible polish.
- **Fully responsive** — phone (stacked, horizontal snap gallery, sticky
  generate bar), tablet, desktop — genuinely different layouts.

## v5 — Sheet Splitter

*(Superseded by the v6.6 dedicated Slicer lane — same engine, proper tool.)*

Upload a whole sprite sheet and the app no longer treats it as one blob:
grid or auto-detect split, background knockout, numbered piece picker,
animated preview, PNG + manifest JSON export.

## v4 — reliability + procedural variety

- **AI retry with backoff** — Pollinations rate-limits anonymous bursts
  (HTTP 402/429). The app now retries 3× (immediate, +3s, +9s) with the
  attempt shown in the pipeline stepper ("Row gen — retry 2/3…"). If all
  retries fail you get an honest amber message (not a dead red error), the
  stale strip is cleared, and the retry bar offers **Retry with stricter
  prompt** plus one-click **Use Procedural instead**.
- **Procedural character archetypes** — biped, quadruped, flyer/bird (real
  wing-flap frames), slime (squash & stretch hops), robot (rigid servo
  angles, blinking visor) — each with 4 palettes (classic, ember, frost,
  toxic) and a ↻ re-roll shuffle button.
- **More tiles** — grass, sand, stone, brick, wood planks, metal plates,
  dungeon, plus animated 2-frame water. All wrap seamlessly (brick's
  edge-clipping bug fixed).
- **More UI elements** — button, icon, panel, plus spinning coin, gem,
  beating heart, twinkling star, and a draining health bar.
- **More effects** — explosion, fire, smoke, sparkle, magic ring, slash
  arc, particles, power-up, magic.

## v3 — "alive" edition

- **Theme switcher** — 6 themes in the tracker's Customize spirit (Violet
  dusk, Midnight, Ocean, Ember, Forest, Porcelain). Swaps CSS variables
  live, no reload, choice persists in `localStorage`.
- **Animated background aura** — three slow-drifting, theme-aware glow
  orbs behind the app (transform/opacity only, never janks the canvas
  pipeline), plus a subtle vignette. Toggle + intensity slider in the
  Customize popover; `prefers-reduced-motion` disables the drift.
- **Alive micro-interactions** — glowing primary button with hover lift,
  satisfying tick-pop on completed pipeline steps, hover lifts on
  cards/tabs, smooth theme transitions. Tasteful, not a rave.

## v2

- **M4-styled UI** — same design language as the portfolio and tracker
  (violet accent, cards, chips), sticky blurred top bar.
- **Dedicated phone layout** — stacked thumb-first flow with a sticky
  bottom Generate button; PC keeps the wide two-panel tool layout.
- **Prompt booster** — one-word prompts ("Zombie") are auto-expanded with
  style / view / palette guidance before hitting the AI. The exact prompt
  sent is shown under "prompt sent to AI" (collapsible).
- **Flat-background enforcement** — stronger prompt language plus a
  key-coverage sanity check: if the model returns a gradient/wash instead
  of a flat key, you get an amber warning + retry instead of silent garbage.
- **Hi-res strips** — AI rows now request ≥1024px wide so frames carry
  usable detail.
- **Slot-slice fallback** — when blob recovery can't find N poses (merged
  strip), the pipeline cuts even slots and continues with an amber warning
  instead of dying. Frames are flagged `slotSliced` in the manifest.
- **Retry with stricter prompt** — one tap re-runs with hard isolation
  instructions appended.

## Live

**https://m4ster-sprite-gen.vercel.app**

## What it generates

| Category | Output |
|---|---|
| **Character** | idle / walk / run / jump / attack states, N frames each — 5 archetypes (biped, quadruped, flyer, slime, robot) × 4 palettes |
| **Tile** | seamless tileable textures (grass, sand, stone, brick, wood, metal, water, dungeon), with a 3×3 wrap preview |
| **UI** | buttons, icons, panels, coins, gems, hearts, stars, health bars |
| **Effect** | explosions, fire, smoke, sparkles, magic rings, slash arcs, particles, power-ups, magic — frame sequences |

## How it generates (the pipeline)

Every generation walks six visible steps in the UI:

1. **Prompt** — one prompt per animation state, asking for a horizontal
   row-strip of poses on a flat chroma background, one pose per invisible slot.
2. **Row gen** — the image source. **AI** uses whichever model is picked
   in the model switcher (Pollinations, AI Horde, Hugging Face, OpenRouter);
   **Procedural** is a seeded offline pixel-art generator; **Upload** accepts
   your own strip (any image in, frames out).
3. **Alpha cleanup** — chroma key with a color-distance threshold, plus
   despill with soft alpha on anti-aliased edges so silhouettes stay clean
   instead of getting chewed into a hard cut.
4. **Frame extract** — content-based: flood-fill connected components, take
   the N biggest as pose seeds, sort left-to-right, fit into cells
   (aspect-preserving, never upscaled, feet bottom-aligned). If N poses can't
   be recovered it falls back to **even slot slicing** with an amber warning
   (frames flagged `slotSliced` in the manifest) instead of dying — loud fail
   remains only when the strip has no usable ink at all.
5. **Atlas pack** — one state per row, frames left-to-right, plus a manifest
   JSON with absolute frame rects, per-state fps/durations, and loop flags.
   Your game reads the rects; it never recomputes them.
6. **Done** — animated preview, reorder frames (non-destructive: originals
   are kept untouched, reorder only rewrites manifest order), and export.

Everything after the image call is deterministic: same input pixels give the
same output pixels, every time.

## Export

- `m4ster-sprite-sheet.png` — the packed atlas
- `m4ster-sprite-atlas.json` — manifest (frame rects, fps, durations, loop flags, run revision)
- **Bundle** — one button: sheet PNG + animated GIF preview + manifest JSON (v2.2.0)
- individual frame PNGs (click any frame thumbnail, or bulk download)
- **Splitter:** `m4ster-split-animation.png` + `m4ster-split-animation.json`
  (manifest v2.2.0, `engine: "splitter"`) — one button downloads both

## Using exports in engines

The manifest JSON carries absolute frame rects (`frameLayout.rows.<name>.rects`
as `{x, y, w, h}`) plus per-animation `fps`, `durationsMs`, and `loop`.
Your game reads the rects — never recomputes them.

**Unity** — import the PNG into `Assets/`, select it → Texture Type:
Sprite (2D and UI) → Sprite Mode: Multiple → Apply → open Sprite Editor →
Slice → Grid By Cell Size (or Automatic) → Slice → Apply. Drag sprites into
the scene; match animation order to the manifest's `frameOrder`.

**Godot 4** — import the PNG; in an `AnimatedSprite2D` add a `SpriteFrames`
resource → "Add frames from sprite sheet" (set H/V frames to the atlas
grid). Or in code: `var t := AtlasTexture.new(); t.atlas = load("sheet.png");`
`t.region = Rect2(x, y, w, h)` ← rects straight from the manifest JSON.

**Unreal (Paper 2D)** — import the PNG → right-click → Sprite Actions →
Extract Sprites (grid mode) → select the sprites → right-click → Create
Flipbook → set Frames Per Second from the manifest `fps`. Drop the flipbook
into a Paper Flipbook component; `loop` comes from the manifest too.

## Run it locally

It's a static site — no build step, no dependencies:

```bash
npx serve .
# or
python3 -m http.server
```

## Tech

Vanilla HTML/CSS/JS + Canvas API. Zero frameworks, zero build, zero tracking.

## License

MIT — see [LICENSE](LICENSE).
