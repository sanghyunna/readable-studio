---
name: social-x-post-card
zh_name: "X (Twitter) 帖子卡"
en_name: "X / Twitter Post Card"
emoji: "𝕏"
description: "Realistic X post card with engagement metrics (likes, reposts, views), suited to video overlays or shareable image cards."
zh_description: "拟真 X 推文卡片 + 互动数据 (likes/reposts/views), 适配视频叠加或图卡分享"
en_description: "Realistic X post card with engagement metrics (likes, reposts, views), suited to video overlays or shareable image cards."
category: card
scenario: marketing
aspect_hint: "1280×720 or 1080×1080"
featured: 44
tags: ["twitter", "x", "social", "card", "overlay"]
example_id: sample-social-x-post-card
example_name: "X Post Card · AlchainHust Quote"
example_format: markdown
example_tagline: "X dark mode with engagement metrics"
example_desc: "A short quote post with 12.3K likes, 1.2K reposts, and a verified badge"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · x-post"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: marketing
  upstream: "https://github.com/nexu-io/html-anything"
  preview: { type: html, entry: index.html, reload: debounce-100 }
  design_system: { requires: false }
  example_prompt: "Use the X / Twitter Post Card template to turn my content into a realistic X post card with engagement metrics for a video overlay or shareable image card. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「X (Twitter) 帖子卡」模板把我的内容做成一份「拟真 X 推文卡片 + 互动数据 (likes/reposts/views), 适配视频叠加或图卡分享」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

# X / Twitter Post Card

Render user-supplied post content as a high-fidelity X card for video overlays, image sharing, or knowledge captures.

- Center a 1280×720 or 1080×1080 card on a dark `#0f1419` or light `#ffffff` background. Use 16px rounding, a one-pixel theme border, and 16px padding.
- Include a CSS-gradient avatar, display name, `@handle`, verified mark, timestamp, 17–22px body, optional quote/image card, four inline-SVG engagement actions, and the X logo.
- Use Chirp with Inter or Segoe UI fallbacks; support CJK content with Noto Sans SC or PingFang SC. Use `#1d9bf0` for links, mentions, and hashtags.
- Keep counts compact (`1.2K`, `4.5M`). Use only supplied content, never external images or invented posts. If supplied data needs a summary, write a post of at most 280 characters.
