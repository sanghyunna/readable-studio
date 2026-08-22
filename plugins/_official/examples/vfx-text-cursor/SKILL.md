---
name: vfx-text-cursor
zh_name: "VFX 文字光标"
en_name: "VFX Text Cursor"
emoji: "✨"
description: "Cursor light trail, chromatic rays, and directional flares for word-by-word quote reveals in video intros."
zh_description: "光标拖光 + 彩色像散射线 + 定向光斑, 适合视频片头逐字揭示金句"
en_description: "Cursor light trail, chromatic rays, and directional flares for word-by-word quote reveals in video intros."
category: video
scenario: video
aspect_hint: "1920×1080 (16:9)"
featured: 38
recommended: 7
tags: ["vfx", "text", "cursor", "chromatic", "reveal", "frame"]
example_id: sample-vfx-text-cursor
example_name: "VFX Cursor · Opening Quote"
example_format: markdown
example_tagline: "Word-by-word reveal + chromatic light trail"
example_desc: "Cursor typing with hot pink + cyan chromatic aberration, for video intros"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · vfx-text-cursor"
readable:
  mode: video
  surface: video
  scenario: video
  featured: 0.15
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the VFX Text Cursor template to turn my content into a video-intro quote reveal with cursor light trails, chromatic rays, and directional flares. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「VFX 文字光标」模板把我的内容做成一段「光标拖光 + 彩色像散射线 + 定向光斑, 适合视频片头逐字揭示金句」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

[Template: VFX Text Cursor]
[Intent] Video opening / hero frame — a cursor "types" across the canvas, text reveals word by word, trailing a chromatic-aberration streak and directional light flares. Inspired by html-frames vfx-text-cursor.

[Canvas] 1920x1080, background `#06070a` matte black or `#0a0d12` (warm-leaning blue tint); add a subtle vignette.

[Content]
- One quote (any language), centered, font size 6-8vw, weight 700, font `Inter Tight` / `Source Sans 3` / `Noto Sans SC`.
- Reveal character by character, 80ms interval per character; the current character is followed by a cursor `▍` (or a thin vertical bar).
- Already-revealed text defaults to white `#f5f5f7`, opacity 1; the about-to-reveal position gets a chromatic ghost: a `text-shadow: 2px 0 #ff3b6f, -2px 0 #00d4ff` at the moment of reveal, converging back to normal within 200ms.
- The cursor itself: a 16px-wide rectangle, color = accent (pick 1: hot pink `#ff3b6f` / cyan `#00d4ff` / amber `#ffb547`), blinking via `@keyframes` on a 1.0s cycle; trailing a 60-120px motion-blur trail (radial gradient fading to transparent).

[Flares / rays]
- Randomly spawn 3-5 **directional light flares** (light leak) near the typing position: thin elongated rectangles using `linear-gradient(45deg, transparent, accent20, transparent)` + `mix-blend-mode: screen`, at irregular angles.
- Once the text finishes typing, add a 0.5s shimmer sweep across the whole line (a band of light sweeping across).

[Fields]
- Top caption (uppercase, letter-spacing 0.18em, 11px, opacity 0.5): "FRAME 01 · OPENING".
- Subtitle beneath the text (24-28px, opacity 0.6): source / chapter.
- Bottom-right timecode (`00:03:21` mono).

[Design details]
- **Never**: multi-color rainbow chromatic aberration (use only 1 binary pair like hot pink + cyan, not full R/G/B).
- Fonts: Latin text `Inter Tight` Bold; CJK text `Noto Sans SC` Bold; no serif fonts allowed.
- Motion via `@keyframes` + a JS timer (`setTimeout` per character), and must be disable-able via `prefers-reduced-motion` (show all text immediately instead).
- Must use the user-provided quote; do not invent one.
- Single-file HTML; no external resources besides fonts.
