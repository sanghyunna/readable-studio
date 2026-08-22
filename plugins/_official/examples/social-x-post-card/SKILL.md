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
example_tagline: "X dark mode + engagement stats"
example_desc: "A standout-quote tweet + 12.3K likes / 1.2K reposts + verified badge"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · x-post"
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
  example_prompt: "Use the X / Twitter Post Card template to turn my content into a realistic X post card with engagement metrics for a video overlay or shareable image card. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「X (Twitter) 帖子卡」模板把我的内容做成一份「拟真 X 推文卡片 + 互动数据 (likes/reposts/views), 适配视频叠加或图卡分享」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

【Template: X (Twitter) Post Card】
【Intent】Render a tweet's content (or a user's standout quote) into a highly realistic X post card, for video overlays, X image posts, or knowledge capture. Inspired by html-frames x-post.

【Canvas】1280×720 or 1080×1080, dark background `#0f1419` or light background `#ffffff` (per X theme); card centered, soft shadow.

【Card structure】
- Outer frame: 16px rounded corners, 1px border `#2f3336` (dark) / `#eff3f4` (light), 16px padding.
- Top row: avatar (48×48 circle, CSS gradient placeholder) + display name + handle `@username` + verified blue check + timestamp (mono, 12px, gray).
- Body text: 17-22px, weight 400; links in X blue `#1d9bf0`; hashtags same color; mentions same color; 0.6em paragraph spacing.
- Optional: quote card (embedded small card, gray background, 12px rounded corners).
- Optional: 1 image (CSS gradient + description placeholder, no external image URLs), 16:9 ratio, 12px rounded corners.
- Engagement row: 4 icons + numbers (reply / repost / quote / like), inline SVG icons (X's official style), gray, color change on hover.
- Top-right X logo, single-line SVG.
- View count row: 👁️ + number (small text).

【Fonts】
- Latin: `Chirp` (X's font) → fallback `Inter` or `Segoe UI`.
- Chinese: `Noto Sans SC` / `PingFang SC`.
- Numbers: same main font, not mono.

【Design details】
- Light palette: bg `#fff`, text `#0f1419`, secondary `#536471`, border `#eff3f4`, accent `#1d9bf0`.
- Dark palette (recommended, for video overlays): bg `#000`, text `#e7e9ea`, secondary `#71767b`, border `#2f3336`, accent `#1d9bf0`.
- Number formatting: 1.2K / 4.5M (not raw 1234).
- Content must come from user input; never fabricate a tweet.
- If the user's input is data → auto-summarize into a single "standout quote" tweet (≤ 280 characters).
- Single-file HTML; inline SVG icons; no external image URLs.
- Optional: add a subtle radial highlight `radial-gradient(...)` behind the card to boost readability for video overlays.
