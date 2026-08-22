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
example_tagline: "Seven-card carousel with a muted gradient"
example_desc: "Practical knowledge-card set for sharing as screenshots"
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

## Xiaohongshu Card

- Output a vertical sequence of `w-[1080px] h-[1440px]` cards. Use three to six cards for short content and more for long content; each card carries one idea.
- Start with a large-title cover, one-line subtitle, and a compelling save/share label.
- Expand one point per middle card with an emoji, a short sentence, and one or two examples.
- End with a summary and a follow, save, or comment call to action.
- Use soft muted or pink palettes, rounded elements, generous whitespace, large type, wide leading, and high contrast for mobile reading.
- Add a small author or date watermark at each lower right.
