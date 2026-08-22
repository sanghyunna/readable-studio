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
example_name: "NYT-Style Line Chart · Global Users"
example_format: markdown
example_tagline: "Editorial chart with staggered reveal"
example_desc: "Eight years of weekly-active-user data with NYT-red accents and mono annotations"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · data-chart"
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

## NYT-Style Data Chart Frame

- Use a `1920×1080` warm-white `#f7f5ee` or ink-black `#0e0e0e` canvas with contrasting type.
- Add an 11px uppercase accent kicker, a 5.6vw Cheltenham, Playfair, or Source Serif Pro conclusion headline, and a chart occupying 55–65% of the frame. Derive the conclusion from the supplied data rather than merely describing the chart.
- For lines, use one or two 2.5px ink or 1.5px dashed series with 6px points and mono annotations. For bars, use ink plus at most one accent highlight. For a range chart, use a `#e6e2d2` band around an ink center line.
- Add a 10px mono source/footer and stagger title, kicker, line draw, and label animations; honor reduced motion.
- Prefer concise handwritten SVG; chart.js or d3 require an explicit jsDelivr import. Use one ink color and one red, mint, or warm-orange accent, restrained axis ticks, no full-screen grids, shadows, 3D bars, or emoji. Keep the artifact to one HTML file and annotate estimated textual-input data as schematic.
