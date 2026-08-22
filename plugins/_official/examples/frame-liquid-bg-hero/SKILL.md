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
example_desc: "Multi-layer radial-gradient breathing background + difference-blend text"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · vfx-liquid-background"
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

【Template: Liquid Background Hero】
【Intent】Works as a video intro frame, a SaaS landing page top hero, or a poster background. WebGL-style fluid feel, but rendered as a degraded CSS / canvas fallback so the single file can be opened by double-click. Inspired by html-frames vfx-liquid-background.

【Canvas】1920×1080 (landscape) or 1080×1920 (portrait), pick one. Background fills the full canvas.

【Liquid background — 3 implementations, pick per user preference】
1. **CSS multi-layer radial-gradient staggered breathing** (most stable, default recommendation):
   - 3-5 large ellipse `radial-gradient(...)` layers, colors drawn from the palette.
   - Each ellipse gets its own `@keyframes` translate + scale + hue-rotate, 8-14s period, staggered; the whole composition is layered with `mix-blend-mode: screen` or `overlay`.
   - Add a top `backdrop-filter: blur(80px)` layer for softer edges.
2. **Canvas + simple perlin noise** (intermediate):
   - ~80 lines of inline JS, use `requestAnimationFrame` to draw metaballs or a simplex noise field.
   - Enable when performance allows; fall back to a static screenshot under `prefers-reduced-motion`.
3. **WebGL fragment shader** (advanced, use with caution):
   - Pull in `regl` via jsdelivr CDN, or inline plain WebGL.
   - Shader writes domain-warp noise; a single quad, one `u_time` uniform.

【Top text layer】
- Centered or bottom-left: one giant quote (5-7vw, serif or bold sans), fonts: `Source Serif Pro` / `Inter Tight` / `Manrope Black`.
- Text color is paper white `#fafaf8` or ink, depending on background lightness; add `mix-blend-mode: difference` so it stays readable over any fluid color.
- One line of subtitle (small sans, opacity 0.7).
- Optional bottom CTA chip or hairline + metadata row.

【Palette — pick 1 of 4, no rainbow】
- 🌅 **Solar Peach** — `#ffb18a` + `#f78b4c` + `#d97757`, warm orange-peach.
- 🌊 **Ocean Aqua** — `#5ac8fa` + `#0a84ff` + `#1e3a8a`, ocean blue.
- 🌌 **Aurora Violet** — `#a78bfa` + `#7c5cff` + `#1e1b4b`, aurora purple.
- 🌿 **Forest Mint** — `#86efac` + `#34d399` + `#065f46`, mossy forest.

【Design details】
- Forbidden: multi-color rainbow (>4 hues), PowerPoint-style gradients, neon glow overlays.
- Fonts: for Chinese text use `Noto Serif SC` (display) / `Noto Sans SC` (subtitle).
- No external image links; everything is CSS + SVG + optional canvas.
- Must use the user-provided quote / title; if the user's input is data → distill it into a quote of ≤ 18 characters.
- Single-file HTML, animation can be turned off via `prefers-reduced-motion`.
