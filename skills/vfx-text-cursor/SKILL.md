---
name: vfx-text-cursor
zh_name: "VFX 文字光标"
en_name: "VFX Text Cursor"
emoji: "✨"
description: "Cursor light trail, chromatic rays, and directional flares for word-by-word quote reveals in video intros."
zh_description: "光标拖光 + 彩色像散射线 + 定向光斑, 适合视频片头逐字揭示金句"
en_description: "Cursor light trail, chromatic rays, and directional flares for word-by-word quote reveals in video intros."
category: video
scenario: video
aspect_hint: "1920×1080 (16:9)"
featured: 38
recommended: 7
tags: ["vfx", "text", "cursor", "chromatic", "reveal", "frame"]
example_id: sample-vfx-text-cursor
example_name: "VFX Cursor · Opening Quote"
example_format: markdown
example_tagline: "Word-by-word reveal with chromatic trails"
example_desc: "Hot-pink and cyan cursor typing effect for a video opening"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · vfx-text-cursor"
readable:
  mode: video
  surface: video
  scenario: video
  featured: 0.15
  upstream: "https://github.com/nexu-io/html-anything"
  preview: { type: html, entry: index.html, reload: debounce-100 }
  design_system: { requires: false }
  example_prompt: "Use the VFX Text Cursor template to turn my content into a video-intro quote reveal with cursor light trails, chromatic rays, and directional flares. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「VFX 文字光标」模板把我的内容做成一段「光标拖光 + 彩色像散射线 + 定向光斑, 适合视频片头逐字揭示金句」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

# VFX Text Cursor

Make a 1920×1080 opening or hero frame where a cursor reveals a supplied quote word by word, leaving chromatic trails and directional light leaks.

- Set the quote in Inter Tight, Source Sans 3, or Noto Sans SC at 6–8vw, centered on `#06070a` or `#0a0d12`. Reveal characters at 80ms intervals with a thin cursor.
- Use white text, a short-lived `#ff3b6f` / `#00d4ff` chromatic shadow, and one hot-pink, cyan, or amber cursor with a 60–120px radial-gradient trail.
- Add three to five angled light leaks with `linear-gradient` and `mix-blend-mode: screen`, then a 0.5s shimmer when the quote is complete.
- Include a small caption, subtitle/source, and timecode. Avoid rainbow RGB effects and serif type. Use `prefers-reduced-motion` to reveal all copy immediately.
