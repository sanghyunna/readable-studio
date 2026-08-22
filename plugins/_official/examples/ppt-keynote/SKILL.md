---
name: ppt-keynote
zh_name: "Keynote 风格 PPT"
en_name: "Keynote-style Slides"
emoji: "🎬"
description: "Apple Keynote-quality slides, one card per screen, with keyboard left/right navigation."
zh_description: "苹果 Keynote 级别幻灯片, 一屏一卡, 键盘左右切换"
en_description: "Apple Keynote-quality slides, one card per screen, with keyboard left/right navigation."
category: slides
scenario: marketing
aspect_hint: "16:9 (1280×720)"
featured: 19
tags: ["slides", "deck", "presentation", "keynote", "talk"]
example_id: sample-ppt-html-anything
example_name: "Keynote PPT · Product Intro"
example_format: markdown
example_tagline: "7 slides, product story, clear"
example_desc: "Apple Keynote-style product intro, ←/→ to switch"
readable:
  mode: deck
  surface: web
  scenario: marketing
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Keynote-style Slides template to turn my content into Apple Keynote-quality slides with one card per screen and keyboard left/right navigation. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「Keynote 风格 PPT」模板把我的内容做成一套「苹果 Keynote 级别幻灯片, 一屏一卡, 键盘左右切换」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

[Template: Keynote-style Slides]
- Each slide is a `<section class="slide">`, 1280 wide by 720 tall overall, centered, with a gradient background.
- Keep each slide's content minimal: a large headline + 1-3 lines of supporting text; or a single data chart; or one punchy quote.
- Font sizes: headline `text-7xl font-semibold tracking-tight`, subtitle `text-2xl text-neutral-500`.
- The first slide is the cover (title + speaker / date), the last slide is "Thanks." or a call to action.
- Small indicator in the top-right corner: current page / total pages.
- Add a JavaScript snippet that listens for ArrowLeft / ArrowRight / spacebar to switch slides, while keeping the hash (#/3) in sync.
- Use a fade-in animation between slides.
- Keep generous whitespace, align data cards with a grid layout, and keep colors restrained.
