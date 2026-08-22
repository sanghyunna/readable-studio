---
name: ppt-keynote
zh_name: "Keynote 风格 PPT"
en_name: "Keynote-style Slides"
emoji: "📗"
description: "Apple Keynote-quality slides, one card per screen, with keyboard left/right navigation."
zh_description: "苹果 Keynote 级别幻灯片, 一屏一卡, 键盘左右切换"
en_description: "Apple Keynote-quality slides, one card per screen, with keyboard left/right navigation."
category: slides
scenario: marketing
aspect_hint: "16:9 (1280×720)"
featured: 19
tags: ["slides", "deck", "presentation", "keynote", "talk"]
example_id: sample-ppt-html-anything
example_name: "Keynote Slides · Product introduction"
example_format: markdown
example_tagline: "Tell the product story in seven slides"
example_desc: "An Apple Keynote-style product introduction with left/right navigation"
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

# Keynote-style Slides

- Make every slide a `<section class="slide">` on a centered 1280×720 canvas with a gradient background.
- Keep each slide minimal: a large headline and one to three supporting lines, a data visual, or a single quote.
- Use `text-7xl font-semibold tracking-tight` for headings and `text-2xl text-neutral-500` for subtitles.
- Use a cover slide (topic, speaker, and date) and a closing slide with "Thanks." or a call to action.
- Show a small current-page/total-pages indicator in the upper-right corner.
- Add JavaScript keyboard controls for ArrowLeft, ArrowRight, and Space, and keep the URL hash in sync (`#/3`).
- Fade between slides; preserve generous whitespace, grid-aligned data cards, and a restrained palette.
