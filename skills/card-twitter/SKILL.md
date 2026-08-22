---
name: card-twitter
zh_name: "Twitter 分享卡"
en_name: "Twitter Share Card"
emoji: "🐦"
description: "Twitter quote or data card designed to pair with a post."
zh_description: "推特金句 / 数据卡, 适合配推文"
en_description: "Twitter quote or data card designed to pair with a post."
category: card
scenario: marketing
aspect_hint: "1600×900 (16:9)"
tags: ["twitter", "x", "quote", "quote-card"]
example_id: sample-twitter-quote
example_name: "Twitter Card · Quote"
example_format: text
example_tagline: "16:9 dark quote card, ready to pair with a post"
example_desc: "High-contrast quote template with a grid and gradient glow"
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
  example_prompt: "Use the Twitter Share Card template to turn my content into a Twitter quote or data card designed to pair with a post. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「Twitter 分享卡」模板把我的内容做成一份「推特金句 / 数据卡, 适合配推文」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

## Twitter Share Card

- Use a `w-[1600px] h-[900px]` container in either dark or light mode to suit the message.
- Center one prominent quote in `text-6xl font-semibold`, limited to two or three lines.
- Add the author, avatar placeholder, and handle beneath it.
- Put an `Insight`, `Data`, or `Quote` label at upper left and a brand watermark at lower right.
- Use a restrained grid, noise, or dot texture; the finished screenshot should be ready to post.
