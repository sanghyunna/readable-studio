---
name: frame-logo-outro
zh_name: "品牌 Logo 收尾帧"
en_name: "Logo Outro Frame"
emoji: "🎬"
description: "Segmented logo assembly, glow bloom, and tagline reveal for video outros or brand closing frames."
zh_description: "Logo 分块组装入场 + glow bloom + tagline 揭示, 适合视频片尾 / 品牌闭幕"
en_description: "Segmented logo assembly, glow bloom, and tagline reveal for video outros or brand closing frames."
category: video
scenario: video
aspect_hint: "1920×1080 (16:9)"
featured: 40
recommended: 8
tags: ["logo", "outro", "branding", "end-card", "frame"]
example_id: sample-frame-logo-outro
example_name: "Brand Logo Outro · HTML Anything"
example_format: markdown
example_tagline: "Midnight Indigo + glow bloom"
example_desc: "Logo assembly, brand name, tagline, and CTA for a video outro"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · logo-outro"
readable:
  mode: video
  surface: video
  scenario: video
  featured: 0.16
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Logo Outro Frame template to turn my content into a video outro or brand closing frame with segmented logo assembly, glow bloom, and tagline reveal. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「品牌 Logo 收尾帧」模板把我的内容做成一段「Logo 分块组装入场 + glow bloom + tagline 揭示, 适合视频片尾 / 品牌闭幕」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

## Logo Outro

Create a Hyperframes-inspired brand closing frame on a `1920×1080` black `#08090c` or deep-brand-color canvas with a subtle radial vignette.

- Build the centered logo from four to eight CSS or inline-SVG geometric pieces. Bring pieces in from different directions (±100px), `scale(1.4)` to `scale(1)`, and opacity zero to one, staggered by 80ms over 1.2s.
- After assembly, apply `drop-shadow(0 0 24px <accent>40)` and a 500ms mask-image shimmer. Reveal the 48–72px brand name after 1.4s and the 24–28px tagline after 1.8s.
- Add a bottom CTA/metadata row such as `htmlanything.dev · @htmlanything · 2026` in 11px uppercase mono with a hairline divider.
- Choose one palette only: Midnight Indigo (`#08090c`, `#7c5cff`), Solar Amber (`#0e0a08`, `#ffb547`), Forest Mint (`#0a1410`, `#5fb38a`), or Bone & Ink (`#f1efea`, `#0a0a0b`).
- Never use a linked logo image. Use CSS or inline SVG, honor `prefers-reduced-motion`, use the supplied brand name and tagline (or the documented fallback), freeze after completion, and keep the artifact to one HTML file.
