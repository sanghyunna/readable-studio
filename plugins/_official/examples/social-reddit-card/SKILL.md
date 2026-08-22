---
name: social-reddit-card
zh_name: "Reddit 帖子卡"
en_name: "Reddit Post Card"
emoji: "🔺"
description: "Realistic Reddit post card with vote rail and comment count, suited to video overlays or story sharing."
zh_description: "拟真 Reddit 帖子卡 + 上下投票 + 评论数, 适合视频叠加 / 故事分享"
en_description: "Realistic Reddit post card with vote rail and comment count, suited to video overlays or story sharing."
category: card
scenario: marketing
aspect_hint: "1280×720 or 800×600"
featured: 42
tags: ["reddit", "social", "card", "overlay", "story"]
example_id: sample-social-reddit-card
example_name: "Reddit Post · r/programming"
example_format: markdown
example_tagline: "Reddit dark mode + vote rail"
example_desc: "An AITA-style story · 12.3k upvotes · 1.2k comments"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · reddit-post"
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
  example_prompt: "Use the Reddit Post Card template to turn my content into a realistic Reddit post card with vote rail and comment count for a video overlay or story share. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「Reddit 帖子卡」模板把我的内容做成一份「拟真 Reddit 帖子卡 + 上下投票 + 评论数, 适合视频叠加 / 故事分享」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

【Template: Reddit Post Card】
【Intent】Render a story / question / joke as a Reddit post card, for video overlays or social media story sharing. Inspired by html-frames reddit-post.

【Canvas】1280×720 (video overlay) or 800×600 (single card share); background transparent or dark `#0b1416`.

【Card Structure】
- Outer frame: 16px rounded corners, bg white `#ffffff` (light) or `#1a1a1b` (dark, recommended for video overlay), border 1px `#edeff1` / `#343536`.
- Left **vote rail** (40-56px wide):
  - Up arrow ▲ (16px, `#878a8c`, turns orange `#ff4500` on hover).
  - Vote count (Inter, 17px, weight 700, centered, color: 0 gray / positive orange / negative blue); large numbers use `12.3k` format.
  - Down arrow ▼ (turns blue `#7193ff` on hover).
- Main body area:
  - Top meta row: subreddit icon (CSS circle + letter) + `r/subreddit` (bold) + `· Posted by u/username · 3h` (small gray text).
  - **Title** (Inter / IBM Plex Sans, 22-28px, weight 500, dark text).
  - Content: 16px body text, or a blockquote, or 1 image (CSS gradient placeholder).
  - Bottom action row: 💬 `1.2k Comments` · 🏆 Awards · ⤴️ Share · ⋯ icon.
- Top-right corner Reddit Snoo logo (inline SVG, orange `#ff4500`).

【Fonts】
- Primary: `IBM Plex Sans` → fallback `Inter`, weight 400/500/700.
- Numbers: same as primary font.
- Chinese text: `Noto Sans SC`.

【Design Details】
- Light mode: bg `#fff`, text `#1c1c1c`, secondary `#7c7c7c`.
- Dark mode (recommended): bg `#1a1a1b`, text `#d7dadc`, secondary `#818384`, border `#343536`.
- Vote count colors: positive = `#ff4500`, negative = `#7193ff`, 0 = `#878a8c`.
- Title clickable area can have a subtle background hover effect.
- No external image links allowed; use CSS gradient + description for image placeholders.
- Must use the content provided by the user; auto-generate a reasonable subreddit / username / vote count.
- Single-file HTML; icons as inline SVG (up/down arrows, comment bubble, trophy).
