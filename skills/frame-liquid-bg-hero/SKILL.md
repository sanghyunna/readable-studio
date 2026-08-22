---
name: frame-liquid-bg-hero
zh_name: "流体背景 Hero 帧"
en_name: "Liquid Background Hero"
emoji: "🌊"
description: "WebGL-style fluid displacement background with a quote overlay, suited to video intros, landing heroes, or posters."
zh_description: "WebGL 风流体置换背景 + 顶部叠加金句, 适合视频片头 / landing hero / 海报"
en_description: "WebGL-style fluid displacement background with a quote overlay, suited to video intros, landing heroes, or posters."
category: poster
scenario: video
aspect_hint: "1920×1080 (16:9) or 1080×1920 (9:16)"
featured: 39
tags: ["liquid", "fluid", "background", "hero", "html-in-canvas", "vfx"]
example_id: sample-frame-liquid-bg-hero
example_name: "Liquid Background Hero · Quote"
example_format: markdown
example_tagline: "Aurora Violet fluid"
example_desc: "Layered breathing radial-gradient background with difference text"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · vfx-liquid-background"
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
  example_prompt: "Use the Liquid Background Hero template to turn my content into a WebGL-style fluid displacement background with a quote overlay for a video intro, landing hero, or poster. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「流体背景 Hero 帧」模板把我的内容做成一段「WebGL 风流体置换背景 + 顶部叠加金句, 适合视频片头 / landing hero / 海报」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

## Liquid Background Hero

Create a full-bleed `1920×1080` or `1080×1920` Hyperframes-inspired intro, landing hero, or poster that opens directly as one HTML file.

1. Default to three to five palette-colored `radial-gradient` ellipses, each animated with staggered 8–14s translate, scale, and hue-rotate keyframes. Blend with `screen` or `overlay` and add `backdrop-filter: blur(80px)`.
2. If appropriate, use an inline Canvas metaball or simplex-noise animation that falls back to a static frame for `prefers-reduced-motion`.
3. Use a jsDelivr `regl` dependency or inline WebGL only when a domain-warp shader is explicitly needed.

Place a 5–7vw quote at center or lower left in Source Serif Pro, Inter Tight, or Manrope Black. Use `#fafaf8` or ink with `mix-blend-mode: difference`, a low-opacity subtitle, and an optional CTA or metadata row.

Choose one palette: Solar Peach (`#ffb18a`, `#f78b4c`, `#d97757`), Ocean Aqua (`#5ac8fa`, `#0a84ff`, `#1e3a8a`), Aurora Violet (`#a78bfa`, `#7c5cff`, `#1e1b4b`), or Forest Mint (`#86efac`, `#34d399`, `#065f46`). Avoid rainbow, PowerPoint-style, and neon treatments; use no linked images; derive the quote from supplied content; and honor reduced motion.
