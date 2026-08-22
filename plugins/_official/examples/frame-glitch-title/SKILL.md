---
name: frame-glitch-title
zh_name: "故障艺术标题帧"
en_name: "Glitch Title Frame"
emoji: "⚡"
description: "Digital glitch, chromatic offset, and data-corruption title frame for video transitions or cyberpunk heroes."
zh_description: "数字故障 / 像散偏移 / 数据腐败标题, 适合视频转场 / cyberpunk hero"
en_description: "Digital glitch, chromatic offset, and data-corruption title frame for video transitions or cyberpunk heroes."
category: video
scenario: video
aspect_hint: "1920×1080 (16:9)"
featured: 37
recommended: 6
tags: ["glitch", "cyberpunk", "title", "transition", "vfx", "frame"]
example_id: sample-frame-glitch-title
example_name: "Glitch Title · SIGNAL_LOST"
example_format: markdown
example_tagline: "cyan / magenta chromatic aberration + CRT scanlines"
example_desc: "Giant title + data-corruption artifacts + corner ASCII noise chunks"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · glitch"
readable:
  mode: video
  surface: video
  scenario: video
  featured: 0.14
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Glitch Title Frame template to turn my content into a digital-glitch, chromatic-offset, data-corruption title frame for a video transition or cyberpunk hero. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「故障艺术标题帧」模板把我的内容做成一段「数字故障 / 像散偏移 / 数据腐败标题, 适合视频转场 / cyberpunk hero」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

【Template: Glitch Title Frame】
【Intent】Single-frame hero / video transition / cyberpunk-style title. Inspired by html-frames glitch.

【Canvas】1920×1080, background near-black `#070708` or CRT dark gray `#0d0e10`; add a 56px grid (5% opacity) + horizontal scanlines (8% opacity, 2px spacing).

【Main title】
- Centered, 6-9vw, weight 800/900, font `Space Grotesk Bold` / `Inter Tight Black` / `JetBrains Mono Bold`.
- Color: main layer `#f5f5f7`; layer 2 chromatic-artifact copies behind it:
  - cyan `#00f0ff` translate(`-3px`, `1px`).
  - magenta `#ff2bd6` translate(`3px`, `-1px`).
- Slice the whole layer into 5-8 clip-path segments, each with its own `@keyframes` randomly translateX -10px → 10px over 80-160ms, staggered, to create a "data corruption" chromatic split.
- Trigger a "heavy glitch" every 1.5s — the whole title gets a 1-frame horizontal smear, via `filter: url(#displacementFilter)` or a simple CSS translate.

【Additional layers】
- A top caption line (uppercase mono, 11px, opacity 0.6): `>> SIGNAL_LOST · CH-04 · 14:32:08`.
- A subtitle line below the title (24-28px, mono, opacity 0.7), occasionally swapped with ` ̶▒̶` characters (fake corruption).
- Scattered `█▓▒░` ASCII noise chunks in the corners.
- A bottom timecode (mono, opacity 0.4).
- A noise grain layer over the whole frame `background-image: url("data:image/svg+xml,...turbulence...")`, opacity 6%, mix-blend-mode overlay.

【SVG filter (optional)】
- Define `<filter id="rgbShift">` using `feColorMatrix` + `feOffset` + `feMerge` to offset the R/G/B channels; apply `filter: url(#rgbShift)` to the whole layer during the glitch moment.

【Design details】
- Colors only: black / white / cyan / magenta / a touch of amber warning color; no full rainbow.
- Fonts: Latin `Space Grotesk` or `JetBrains Mono` Bold; CJK `Noto Sans Mono CJK SC` or `Noto Sans SC` Bold.
- No lorem ipsum; must use the user's actual title + subtitle.
- Animation via `@keyframes`, disable-able via `prefers-reduced-motion` (fall back to a static chromatic split).
- Single-file HTML.
