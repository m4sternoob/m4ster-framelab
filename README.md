# m4ster-sprite-gen

**For the gamers, by the gamers.**

Free, open-source, unlimited 2D game sprite generator that runs 100% in your
browser. No API keys, no signup, no credit card, no payments — ever.

Pick a category, describe the sprite, hit **Generate**. You get a packed
sprite sheet PNG plus an atlas manifest JSON your game can read directly.

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
| **Character** | idle / walk / run / jump / attack states, N frames each |
| **Tile** | seamless tileable textures, with a 3×3 wrap preview |
| **UI** | buttons, icons, panels with normal / hover / pressed variants |
| **Effect** | explosions, particles, power-ups, magic — frame sequences |

## How it generates (the pipeline)

Every generation walks six visible steps in the UI:

1. **Prompt** — one prompt per animation state, asking for a horizontal
   row-strip of poses on a flat chroma background, one pose per invisible slot.
2. **Row gen** — the image source. **AI** uses Pollinations (free, no auth);
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
- individual frame PNGs (click any frame thumbnail, or bulk download)

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
