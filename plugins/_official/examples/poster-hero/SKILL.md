---
name: poster-hero
zh_name: "营销海报"
en_name: "Marketing Poster"
emoji: "🖼️"
description: "Vertical poster or Moments-style share image with strong visual impact."
zh_description: "竖版海报 / 朋友圈分享图, 强视觉冲击"
en_description: "Vertical poster or Moments-style share image with strong visual impact."
category: poster
scenario: marketing
aspect_hint: "1080×1920 portrait"
tags: ["poster", "marketing", "social share"]
example_id: sample-poster-launch
example_name: "Marketing Poster · Product Launch"
example_format: markdown
example_tagline: "9:16 Moments share image"
example_desc: "High-contrast launch poster with QR code placeholder + gradient mesh + noise texture"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: marketing
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Marketing Poster template to turn my content into a vertical poster or Moments-style share image with strong visual impact. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「营销海报」模板把我的内容做成一份「竖版海报 / 朋友圈分享图, 强视觉冲击」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

[Template: Marketing Poster]
- Container `w-[1080px] h-[1920px] mx-auto`, full-screen gradient / mesh background.
- Top 30% whitespace + one large emoji or abstract geometric shape.
- Middle main title as the visual center (text-8xl, font-black), one-line subtitle.
- Bottom info cards: 3-5 core points with icon + short phrase.
- Bottom-right corner for brand / QR code (SVG placeholder).
- Use bold colors: gradient background (e.g. from-violet-500 via-fuchsia-500 to-indigo-500), white text + 1 contrasting accent color highlight.
- Use SVG for decorative elements (circles / triangles / waves / noise texture).
