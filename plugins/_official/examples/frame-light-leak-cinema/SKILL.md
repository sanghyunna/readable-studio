---
name: frame-light-leak-cinema
zh_name: "胶片漏光电影帧"
en_name: "Light-Leak Cinematic Frame"
emoji: "🎞️"
description: "Film light leaks, grain, 16:9 letterbox, and large serif type for cinematic openings or chapter cards."
zh_description: "胶片漏光 + 颗粒噪点 + 16:9 letterbox + 衬线大字, 电影感开场 / 章节卡"
en_description: "Film light leaks, grain, 16:9 letterbox, and large serif type for cinematic openings or chapter cards."
category: video
scenario: video
aspect_hint: "2.39:1 letterbox (1920×800) or 16:9 (1920×1080)"
featured: 36
tags: ["cinema", "film", "light-leak", "grain", "letterbox", "frame"]
example_id: sample-frame-light-leak-cinema
example_name: "Film Light Leak · REEL 03"
example_format: markdown
example_tagline: "Warm orange light leak + 35mm grain"
example_desc: "2.39:1 letterbox + large italic serif type + film sprocket holes"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · light-leak"
readable:
  mode: video
  surface: video
  scenario: video
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Light-Leak Cinematic Frame template to turn my content into a cinematic opening or chapter card with film light leaks, grain, letterbox framing, and large serif type. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「胶片漏光电影帧」模板把我的内容做成一段「胶片漏光 + 颗粒噪点 + 16:9 letterbox + 衬线大字, 电影感开场 / 章节卡」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

【Template: Light-Leak Cinematic Frame】
【Intent】A single opening frame for documentaries / personal short films / video chapter cards — warm orange light leaks + 35mm grain + large serif type, classic film texture. Inspired by html-frames light-leak.

【Canvas】
- **2.39:1 letterbox** (recommended): 1920×800, 140px black bars top and bottom (`#000`).
- Or 16:9: 1920×1080, no letterbox.

【Background】
- Base layer: deep warm color (deep reddish-brown `#1a0d08` / ink green `#0a1410` / blue-purple `#0d0e1a`) or a scene depiction (CSS gradient simulating sky / interior / exterior).
- **Light Leak**: 2-3 large `radial-gradient(ellipse at top right, #ffb547 0%, transparent 50%)` plus 1 bottom `linear-gradient(to top, #d97757 0%, transparent 30%)`; use warm orange / peach / rose / dark yellow tones, **no cool blues**.
- **35mm Grain**: full-screen SVG turbulence noise layer, opacity 14%, `mix-blend-mode: overlay`; can also use `background-image: url("data:image/svg+xml,...feTurbulence...")`.
- Optional: one `feDisplacementMap` pass to simulate film wobble (use sparingly).

【Typography】
- Center or bottom-left: large serif type (Source Serif Pro / Playfair Display / EB Garamond) 5-8vw, weight 500 italic; warm white `#f5e9d6` or cream color.
- Subtitle (24-28px), one line, opacity 0.7, same serif.
- Corner caption (uppercase letterspace 0.18em, 10-11px, mono, opacity 0.5): "REEL 03 · CH I · 1985".
- Bottom timecode + shoot location + date (mono, opacity 0.4).

【Optional extras】
- "Film scratches": a few 1-2px vertical white lines, opacity 0.2, irregular spacing (use multiple `box-shadow` insets or multiple `<div>`s).
- "Film sprocket holes": inside the letterbox black bars, evenly spaced small white squares (CSS repeating-linear-gradient).
- Entrance animation: whole frame goes from underexposed (brightness 0.3) → normal within 800ms; light leak position drifts slowly on a 12s cycle.

【Design details】
- Never use more than 4 hues total (dark background + 2 warm leak colors + cream text).
- Strictly forbidden: blue-purple light leaks (breaks the film feel), emoji, neon colors, geometric dashboard decoration.
- CJK text: `Noto Serif SC` has no italic → use `Noto Serif SC` regular with increased letter spacing.
- Must use the user-supplied title; auto-estimate plausible "year / chapter / location" metadata (but sourced from user content).
- Single-file HTML; disable animation via `prefers-reduced-motion`.
