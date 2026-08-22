---
name: social-reddit-card
zh_name: "Reddit 帖子卡"
en_name: "Reddit Post Card"
emoji: "💬"
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
example_tagline: "Reddit dark mode with a vote rail"
example_desc: "An AITA-style story with 12.3k upvotes and 1.2k comments"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · reddit-post"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: marketing
  upstream: "https://github.com/nexu-io/html-anything"
  preview: { type: html, entry: index.html, reload: debounce-100 }
  design_system: { requires: false }
  example_prompt: "Use the Reddit Post Card template to turn my content into a realistic Reddit post card with vote rail and comment count for a video overlay or story share. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「Reddit 帖子卡」模板把我的内容做成一份「拟真 Reddit 帖子卡 + 上下投票 + 评论数, 适合视频叠加 / 故事分享」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

# Reddit Post Card

Turn a story, question, or joke into a Reddit post card for video overlays or social sharing. Use a transparent or `#0b1416` background at 1280×720, or 800×600 for a single card.

- Use a 16px rounded card with a 40–56px vote rail. Arrows are gray, becoming `#ff4500` and `#7193ff` on hover; format large counts as `12.3k`.
- Add a subreddit icon, `r/subreddit`, author/time metadata, a 22–28px title, body or quote, and an action row. Draw the Snoo mark and all icons with inline SVG.
- Use IBM Plex Sans or Inter. Support CJK content with Noto Sans SC. Dark mode uses `#1a1a1b`, `#d7dadc`, `#818384`, and `#343536`.
- Do not use external images. Use CSS gradients for image placeholders and only user-provided content; derive a plausible subreddit, username, and vote count when absent.
