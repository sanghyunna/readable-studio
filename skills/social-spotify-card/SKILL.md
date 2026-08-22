---
name: social-spotify-card
zh_name: "Spotify 正在播放卡"
en_name: "Spotify Now-Playing Card"
emoji: "🎵"
description: "Spotify Now Playing-style card with album art, progress bar, and playback controls, suited to video overlays or personal homepages."
zh_description: "Spotify Now Playing 风格卡: 专辑封面 + 进度条 + 播放控制, 适配视频叠加 / 个人主页"
en_description: "Spotify Now Playing-style card with album art, progress bar, and playback controls, suited to video overlays or personal homepages."
category: card
scenario: personal
aspect_hint: "1280×720 or 600×200"
featured: 43
tags: ["spotify", "music", "now-playing", "card", "overlay"]
example_id: sample-social-spotify-card
example_name: "Spotify Now Playing · Lo-Fi"
example_format: markdown
example_tagline: "Classic Spotify dark card"
example_desc: "Lo-Fi Beats · Chillhop progress at 1:24 / 3:42 with controls"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · spotify-card"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: personal
  upstream: "https://github.com/nexu-io/html-anything"
  preview: { type: html, entry: index.html, reload: debounce-100 }
  design_system: { requires: false }
  example_prompt: "Use the Spotify Now-Playing Card template to turn my content into a Spotify Now Playing-style card with album art, progress bar, and playback controls for a video overlay or personal homepage. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「Spotify 正在播放卡」模板把我的内容做成一份「Spotify Now Playing 风格卡: 专辑封面 + 进度条 + 播放控制, 适配视频叠加 / 个人主页」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

# Spotify Now-Playing Card

Render a song, podcast, or personal introduction as a Spotify-style now-playing card for a video overlay, creator hero, or compact widget.

- Use 1280×720 for an overlay or 600×200 for a compact horizontal widget. Use a 12–16px card with a dark album-derived gradient or `#121212`.
- Create album art from CSS gradients and a monogram or abstract geometry; do not use external images. Place `NOW PLAYING`, title, artist, a four-pixel progress bar with timestamps, and inline-SVG controls beside it.
- Use Spotify Circular or Inter. Keep Spotify dark mode (`#121212`, `#1DB954`, `#b3b3b3`) and optional three-bar animation that honors `prefers-reduced-motion`.
- Treat supplied text as the title and subtitle/author as the artist; use a 3:42 duration only when none is available.
