---
name: html-ppt
description: HTML PPT Studio authors professional static HTML presentations with reusable themes, layouts, and animations. Use for presentations, PPTs, slides, keynotes, decks, slideshows, reveal-style HTML decks, social-media carousels, and multi-slide pitches, reports, or talks that need keyboard navigation.
triggers:
  - ppt
  - deck
  - slides
  - presentation
  - keynote
  - reveal
  - slideshow
  - talk slides
  - pitch deck
  - tech sharing
  - technical presentation
readable:
  mode: deck
  scenario: marketing
  upstream: "https://github.com/lewislulu/html-ppt-skill"
  preview:
    type: html
    entry: index.html
  design_system:
    requires: false
  speaker_notes: true
  animations: true
  example_prompt: "Create a 12-slide HTML presentation with html-ppt. Confirm the content, slide count, audience, preferred theme, and whether to start from pitch-deck, tech-sharing, weekly-report, xhs-post, or presenter-mode-reveal before writing slides."
---

# html-ppt · HTML PPT Studio

Author professional HTML presentations as static files. A theme file defines a
look, a layout file defines a page type, and an animation class defines an
entry effect. Pages share the token-based design system in `assets/base.css`.

## Install

```bash
npx skills add https://github.com/lewislulu/html-ppt-skill
```

No build is required: this is static HTML, CSS, and JavaScript with CDN fonts.

## Included material

- **36 themes** in `assets/themes/*.css`.
- **15 full-deck templates** in `templates/full-decks/<name>/`: eight derived
  from real decks and seven scenario starters, including `presenter-mode-reveal`.
- **31 layouts** in `templates/single-page/*.html` with realistic demo data.
- **27 CSS animations** through `data-anim` and **20 canvas effects** through
  `data-fx`.
- **Keyboard runtime** in `assets/runtime.js`: arrows, T (theme), A
  (animation), F/O, S (presenter mode), N (notes), and R (presenter timer).
- Theme, layout, animation, and full-deck showcase pages, plus a headless
  Chrome PNG-rendering script.

## When to use

Use this for any slide-based result or when turning notes into a presentable
deck. Start from the closest template rather than authoring every slide from
scratch.

### Presenter mode

For talks, speaker notes, presenter view, teleprompter support, workshops, or
courses, use the `presenter-mode-reveal` full-deck template and write a
150–300 word note in each slide's `<aside class="notes">`.

All full-deck templates support the S-key presenter mode. S opens a popup with
pixel-accurate current and next-slide previews, a scrollable speaker script,
and a timer. The cards are draggable and resizable; their layout is stored per
deck in `localStorage`. Preview iframes use the deck's actual HTML, CSS, theme,
fonts, and viewport, then switch slides with `postMessage` without reloading.
The audience and presenter windows synchronize through `BroadcastChannel`.

See [references/presenter-mode.md](references/presenter-mode.md) for the full
guide. Only `presenter-mode-reveal` includes speaker-note examples on every
slide.

## Before authoring, confirm three things

1. **Content and audience:** topic, slide count, and viewers.
2. **Style and theme:** recommend two or three themes when the tone is unclear.
   - Business or investor pitch: `pitch-deck-vc`, `corporate-clean`, `swiss-grid`.
   - Technical talk: `tokyo-night`, `dracula`, `catppuccin-mocha`,
     `terminal-green`, `blueprint`.
   - Social-media carousel: `xiaohongshu-white`, `soft-pastel`,
     `rainbow-gradient`, `magazine-bold`.
   - Academic or report: `academic-paper`, `editorial-serif`, `minimal-white`.
   - Cyber or product launch: `cyberpunk-neon`, `vaporwave`, `y2k-chrome`,
     `neo-brutalism`.
3. **Starting point:** select the closest full-deck template or begin from a
   single-page layout.

For example: “I can make the deck. What content, length, and audience should
it serve? I recommend `tokyo-night`, `xiaohongshu-white`, or
`corporate-clean`; should I start from `tech-sharing`?”

## Quick start

1. Scaffold a deck from the repository root:
   ```bash
   ./scripts/new-deck.sh my-talk
   open examples/my-talk/index.html
   ```
2. Open the deck and press T to cycle themes, or set `#theme-link` directly.
   See [references/themes.md](references/themes.md).
3. Copy a `<section class="slide">...</section>` from
   `templates/single-page/`, then replace its demo data. See
   [references/layouts.md](references/layouts.md).
4. Add `data-anim="fade-up"` or `class="anim-fade-up"` to elements. For canvas
   effects, use `data-fx="knowledge-graph"` and include
   `assets/animations/fx-runtime.js`. See
   [references/animations.md](references/animations.md).
5. Copy a complete `templates/full-decks/<name>/` folder to
   `examples/my-talk/` when it fits. See
   [references/full-decks.md](references/full-decks.md).
6. Render PNGs:
   ```bash
   ./scripts/render.sh templates/theme-showcase.html
   ./scripts/render.sh examples/my-talk/index.html 12
   ```

## Authoring rules

- Start from a template and compose existing layouts before creating a new one.
- Use token variables from `assets/base.css`, not literal colors.
- Keep `.deck-header`, `.deck-footer`, `.slide-number`, and the progress bar
  available to the shared runtime.
- Always load `assets/runtime.js` for keyboard navigation, presenter mode, and
  deep links.
- Use one `.slide` per logical page; the runtime makes `.slide.is-active`
  visible.
- Put speaker-only text in `<div class="notes">`, never in visible slide
  content. Notes are hidden by default and appear only in the presenter UI.

## References

- [Authoring guide](references/authoring-guide.md)
- [Themes](references/themes.md)
- [Layouts](references/layouts.md)
- [Animations](references/animations.md)
- [Full decks](references/full-decks.md)
- [Presenter mode](references/presenter-mode.md)

## File structure

```
html-ppt/
├── SKILL.md
├── references/
├── assets/
│   ├── base.css
│   ├── fonts.css
│   ├── runtime.js
│   ├── themes/*.css
│   └── animations/
├── templates/
│   ├── deck.html
│   ├── theme-showcase.html
│   ├── layout-showcase.html
│   ├── animation-showcase.html
│   ├── full-decks-index.html
│   ├── full-decks/<name>/
│   └── single-page/*.html
├── scripts/
└── examples/demo-deck/
```

## Rendering to PNG

`scripts/render.sh` wraps headless Chrome. For multi-slide capture,
`runtime.js` exposes `#/N` deep links and the script iterates the requested
slide range.

```bash
./scripts/render.sh templates/single-page/kpi-grid.html
./scripts/render.sh examples/demo-deck/index.html 8 out-dir
```

## Keyboard cheat sheet

```
Arrow keys  Space  PgUp  PgDn  Home  End  navigate
F                                       fullscreen
S                                       presenter window
N                                       quick notes drawer
R                                       reset presenter timer
?preview=N                              preview a single slide without chrome
O                                       slide overview
T                                       cycle themes
A                                       cycle the current slide's demo animation
#/N                                     deep-link to slide N
Esc                                     close overlays
```

## License and author

MIT. Copyright (c) 2026 lewis &lt;sudolewis@gmail.com&gt;.
