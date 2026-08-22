---
name: frame-data-chart-nyt
zh_name: "NYT 风数据图表帧"
en_name: "NYT-Style Data Chart Frame"
emoji: "📈"
description: "NYT-newsroom typography, staggered reveal animation, and editorial-grade charts (line, bar, or range band)."
zh_description: "NYT-newsroom 排版 + 错峰揭示动画 + 编辑级图表 (折线/柱/范围带)"
en_description: "NYT-newsroom typography, staggered reveal animation, and editorial-grade charts (line, bar, or range band)."
category: video
scenario: video
aspect_hint: "1920×1080 (16:9)"
featured: 46
tags: ["data", "chart", "nyt", "editorial", "frame"]
example_id: sample-frame-data-chart-nyt
example_name: "NYT-Style Line Chart · Global User Growth"
example_format: markdown
example_tagline: "Editorial-grade chart + staggered reveal"
example_desc: "8-year weekly active user line + NYT red accent + mono annotations"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · data-chart"
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
  example_prompt: "Use the NYT-Style Data Chart Frame template to turn my content into a frame with NYT-newsroom typography, staggered reveal animation, and editorial-grade charts. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「NYT 风数据图表帧」模板把我的内容做成一段「NYT-newsroom 排版 + 错峰揭示动画 + 编辑级图表 (折线/柱/范围带)」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

【Template: NYT-Style Data Chart Frame】
【Intent】Turn a piece of data (CSV / JSON / a one-line takeaway) into a single frame or animated chart with a New York Times column feel, suited to a video clip or a tweet card. Inspired by html-frames data-chart.

【Canvas】1920×1080, pick either a warm white background `#f7f5ee` or an ink black background `#0e0e0e`; text color is the inverse of the background.

【Layout】
- **Top kicker** (11px uppercase letterspace 0.14em, color = accent red `#a91d1d` or mint `#5fb38a`): data source + category, e.g. "GLOBAL · WEEKLY ACTIVE USERS · 2018–2026".
- **Large headline** (Cheltenham / Playfair / Source Serif Pro, 5.6vw, italic subhead optional): a single-sentence takeaway. **The takeaway must be derived from the user's data**, not a description of the chart.
- **Chart area** (55-65% of the canvas):
  - Line: 1-2 lines, primary line solid ink 2.5px, secondary line dashed 1.5px; data points as 6px solid circles; annotate key points with a small black mono label like `2024 · 412M`.
  - Bar: all bars ink monochrome, or with one accent-highlighted bar; large number above the bar top; italic category label below the bar (Cheltenham italic).
  - Range band: light gray fill `#e6e2d2` envelope + ink center line.
- **Bottom source + footnote** (10px mono, opacity 0.6): "Source: [user data] · Chart by html-anything".
- **Staggered reveal animation**: headline fade-in (0s), kicker (200ms), line stroke-dashoffset 1.2s ease-out (400ms), data labels in sequence at 100ms intervals. Can be disabled via `prefers-reduced-motion`.

【Design details】
- **Never**: use the chart.js / d3 library (unless imported via jsdelivr CDN); hand-written SVG is preferred, under 80 inline lines.
- Fonts: headline `Source Serif Pro` or `Cheltenham` (fall back to `Playfair Display`); body `IBM Plex Sans` or `Inter`; data labels `IBM Plex Mono`.
- 1 primary color (ink) + 1 accent (pick one of NYT red `#a91d1d` / editorial mint `#5fb38a` / warm orange `#d97757`).
- Y-axis ticks as hairline only with 3-4 ticks, labels outside the axis in mono type.
- Strictly no full-canvas grid lines, shadows, or 3D bars; strictly no emoji.
- Must use the data the user provides. If the input is a text takeaway, auto-estimate reasonable coordinates (but label it "schematic"); if it's CSV/JSON, plot it directly.
- Single-file HTML; data point annotation format: `<text class="annot">2024 · 412M</text>`.
