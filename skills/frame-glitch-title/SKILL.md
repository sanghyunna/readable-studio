---
name: frame-glitch-title
zh_name: "故障艺术标题帧"
en_name: "Glitch Title Frame"
emoji: "⚡"
description: "Digital glitch, chromatic offset, and data-corruption title frame for video transitions or cyberpunk heroes."
zh_description: "数字故障 / 像散偏移 / 数据腐败标题, 适合视频转场 / cyberpunk hero"
en_description: "Digital glitch, chromatic offset, and data-corruption title frame for video transitions or cyberpunk heroes."
category: video
scenario: video
aspect_hint: "1920×1080 (16:9)"
featured: 37
recommended: 6
tags: ["glitch", "cyberpunk", "title", "transition", "vfx", "frame"]
example_id: sample-frame-glitch-title
example_name: "Glitch Title · SIGNAL_LOST"
example_format: markdown
example_tagline: "Cyan/magenta chromatic offset and CRT scanlines"
example_desc: "Large title, data-corruption artifacts, and corner ASCII noise"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · glitch"
readable:
  mode: video
  surface: video
  scenario: video
  featured: 0.14
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Glitch Title Frame template to turn my content into a digital-glitch, chromatic-offset, data-corruption title frame for a video transition or cyberpunk hero. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「故障艺术标题帧」模板把我的内容做成一段「数字故障 / 像散偏移 / 数据腐败标题, 适合视频转场 / cyberpunk hero」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

## Glitch Title

Create a single-frame cyberpunk hero or video transition inspired by Hyperframes Glitch.

- Use a `1920×1080` near-black `#070708` or CRT-gray `#0d0e10` canvas with a 56px grid at 5% opacity and 2px scanlines at 8% opacity.
- Center a 6–9vw, 800–900 weight title in Space Grotesk Bold, Inter Tight Black, or JetBrains Mono Bold. Set the main layer to `#f5f5f7`, with cyan `#00f0ff` at `translate(-3px, 1px)` and magenta `#ff2bd6` at `translate(3px, -1px)` behind it.
- Slice the title into five to eight clip-path segments. Stagger 80–160ms `translateX(-10px)` to `translateX(10px)` animations and trigger a one-frame horizontal smear every 1.5 seconds.
- Add a mono caption, subtitle, optional fake-glyph substitutions, corner `█▓▒░` noise, a bottom timecode, and a 6%-opacity turbulence grain layer.
- An optional `rgbShift` filter may combine `feColorMatrix`, `feOffset`, and `feMerge` during glitches.
- Limit the palette to black, white, cyan, magenta, and a small amber warning accent. Use user-provided title and subtitle, avoid lorem ipsum, honor `prefers-reduced-motion`, and keep the output to one HTML file.
