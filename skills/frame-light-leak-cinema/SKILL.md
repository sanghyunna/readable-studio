---
name: frame-light-leak-cinema
zh_name: "胶片漏光电影帧"
en_name: "Light-Leak Cinematic Frame"
emoji: "🎞️"
description: "Film light leaks, grain, 16:9 letterbox, and large serif type for cinematic openings or chapter cards."
zh_description: "胶片漏光 + 颗粒噪点 + 16:9 letterbox + 衬线大字, 电影感开场 / 章节卡"
en_description: "Film light leaks, grain, 16:9 letterbox, and large serif type for cinematic openings or chapter cards."
category: video
scenario: video
aspect_hint: "2.39:1 letterbox (1920×800) or 16:9 (1920×1080)"
featured: 36
tags: ["cinema", "film", "light-leak", "grain", "letterbox", "frame"]
example_id: sample-frame-light-leak-cinema
example_name: "Film Light Leak · REEL 03"
example_format: markdown
example_tagline: "Warm orange light leaks and 35mm grain"
example_desc: "2.39:1 letterbox, large italic serif type, and film sprockets"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · light-leak"
readable:
  mode: video
  surface: video
  scenario: video
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Light-Leak Cinematic Frame template to turn my content into a cinematic opening or chapter card with film light leaks, grain, letterbox framing, and large serif type. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「胶片漏光电影帧」模板把我的内容做成一段「胶片漏光 + 颗粒噪点 + 16:9 letterbox + 衬线大字, 电影感开场 / 章节卡」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

## Light-Leak Cinematic Frame

- Choose `1920×800` with 140px black letterbox bars or a full `1920×1080` canvas.
- Use a dark warm background or scene gradient. Layer two or three warm `radial-gradient` light leaks and a lower `linear-gradient`; never use cold-blue leaks. Add an SVG turbulence grain overlay at 14% opacity.
- Set the title in Source Serif Pro, Playfair Display, or EB Garamond at 5–8vw, with a 24–28px subtitle and mono caption/timecode metadata.
- Optional details include vertical film scratches, sprocket holes in the letterbox bars, and an 800ms underexposed-to-normal entrance with slow leak drift.
- Limit the palette to a deep background, two warm leak colors, and cream text. Do not use emoji, neon, dashboard decoration, linked images, or lorem ipsum. Use supplied title metadata, honor reduced motion, and produce one HTML file.
