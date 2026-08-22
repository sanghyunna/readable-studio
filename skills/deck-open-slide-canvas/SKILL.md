---
name: deck-open-slide-canvas
zh_name: "1920 画布自由 Deck"
en_name: "Open-Slide 1920 Canvas Deck"
emoji: "🎨"
description: "Locked 1920x1080 canvas deck with React component-level free composition, not bound to a fixed template."
zh_description: "锁死 1920×1080 画布, React 组件级自由组合, 不绑模板"
en_description: "Locked 1920x1080 canvas deck with React component-level free composition, not bound to a fixed template."
category: slides
scenario: design
aspect_hint: "1920×1080 (16:9)"
featured: 35
recommended: 9
tags: ["canvas", "open-slide", "freeform", "1920", "react"]
example_id: sample-deck-open-slide-canvas
example_name: "1920 Free Canvas · Sea Indigo"
example_format: markdown
example_tagline: "Locked 1920×1080 + Free Composition"
example_desc: "Sea Indigo palette + big-type question page + corner badge"
example_source_url: "https://github.com/1weiho/open-slide"
example_source_label: "1weiho/open-slide"
readable:
  mode: deck
  surface: web
  scenario: design
  featured: 0.17
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Open-Slide 1920 Canvas Deck template to turn my content into a locked 1920x1080 free-composition deck with React component-level layout. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「1920 画布自由 Deck」模板把我的内容做成一套「锁死 1920×1080 画布, React 组件级自由组合, 不绑模板」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

【Template: 1920 Canvas Free Deck】
【Intent】For scenarios that don't want to be boxed in by a fixed template (personal portfolios, unconventional talks, art/design-class decks). Gives a fixed 1920×1080 canvas plus strong type/color constraints, and lets the agent lay out each page as freely as writing a React component. Inspired by 1weiho/open-slide.

【Hard technical spec】
- Canvas: every page strictly `width: 1920px; height: 1080px;`, fit to viewport with `transform: scale(...)` (default `scale(0.7)`, centered).
- **Overflow is absolutely forbidden**: every page's content must fit within 1920×1080, no scrollbars allowed.
- Type scale (px): `2xs:18 · xs:22 · sm:28 · md:36 · lg:48 · xl:64 · 2xl:88 · 3xl:120 · 4xl:160 · 5xl:220`.
- Padding: one of 96 / 128 / 160.
- Every page has `<section class="slide" data-slide-id="<n>">`.

【Palette — pick 1 per deck, keep it fixed throughout】
- 🌫 **Ash & Lime** — bg `#f1efea`, ink `#161616`, accent `#c5e803`.
- 🌌 **Sea Indigo** — bg `#0a0e1a`, ink `#f5f5f7`, accent `#5ac8fa`.
- 🧉 **Mate Mocha** — bg `#1a1411`, ink `#f5e9d6`, accent `#d97757`.
- 🌸 **Pearl Rose** — bg `#fdf6f3`, ink `#1a1015`, accent `#ff5d8f`.

【Layout freedom — this is the core idea】
- No forced template; each page picks its own layout based on **the nature of its content**: cover / question / quote / image-text / three-column / five-column / list / data card / full-bleed image.
- But every page **must follow one rule**: exactly 1 visual focal point (visual hierarchy) — one killer line, one number, one image. Don't "emphasize everything".
- Never stack two paragraphs of equal weight; if you genuinely need parallel content, use a 3-column equal-weight grid.

【Typography】
- Latin: `Inter Tight` (display) + `Inter` (body); or `Source Serif Pro` for an editorial feel.
- CJK: `Noto Sans SC` (sans style) or `Noto Serif SC` (editorial style); don't mix sans + serif.
- mono: `JetBrains Mono` for data / timestamps.

【Design details】
- No decorative emoji (emoji within content is fine); no multi-color rainbow accents; use exactly one accent color.
- No SVG icons from generic libraries like lucide / feather (write inline SVG yourself).
- Add keyboard ← / → navigation with hash sync; fixed corner badges: bottom-right `№N/M`, bottom-left deck title.
- Must use the user's real content; lorem ipsum is strictly forbidden.
- Single-file HTML; Tailwind CDN; no external image links.
