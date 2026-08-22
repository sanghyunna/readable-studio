---
name: card-xiaohongshu
zh_name: "小红书图文卡片"
en_name: "Xiaohongshu Card"
emoji: "📱"
description: "Xiaohongshu-style knowledge cards, arranged as a swipeable multi-card carousel."
zh_description: "小红书风格知识卡片, 多张联排可滑动浏览"
en_description: "Xiaohongshu-style knowledge cards, arranged as a swipeable multi-card carousel."
category: card
scenario: marketing
aspect_hint: "1080×1440 (3:4)"
featured: 24
tags: ["xhs", "xiaohongshu", "carousel", "knowledge-card"]
example_id: sample-xhs-ai-habits
example_name: "Xiaohongshu Card · AI Tool Habits"
example_format: markdown
example_tagline: "7 cards in a row, Morandi gradient"
example_desc: "A collection of practical tip cards, great for screenshotting to Xiaohongshu / Moments"
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
  example_prompt: "Use the Xiaohongshu Card template to turn my content into a Xiaohongshu-style swipeable knowledge-card carousel. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「小红书图文卡片」模板把我的内容做成一份「小红书风格知识卡片, 多张联排可滑动浏览」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

[Template: Xiaohongshu Card]
- Output N consecutive cards, each `w-[1080px] h-[1440px]`, arranged vertically with flex so both the full set and individual cards screenshot well. N is determined by how much content the user has: short content starts at 3-6 cards, longer content should use more (Xiaohongshu caps a single post at 18 images, usually 9 or fewer works best); each card carries only one core idea.
- The first card is the cover: a huge title + 1 line of subtitle + an eye-catching tag (like "Must-read" / "Save this").
- The middle cards expand on the content, one core idea per card, with an emoji + short sentence + 1-2 examples.
- The last card is a summary + call to action (follow / save / comment).
- Color palette: soft Morandi or pink tones; rounded elements, generous whitespace.
- Large font size, wide line spacing, strong contrast (Xiaohongshu is viewed on mobile, so small text is unreadable).
- A small watermark in the bottom-right corner of each card (author name / date).
