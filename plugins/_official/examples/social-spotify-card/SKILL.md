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
example_desc: "Lo-Fi Beats · Chillhop progress bar 1:24 / 3:42 + control row"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · spotify-card"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: personal
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Spotify Now-Playing Card template to turn my content into a Spotify Now Playing-style card with album art, progress bar, and playback controls for a video overlay or personal homepage. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「Spotify 正在播放卡」模板把我的内容做成一份「Spotify Now Playing 风格卡: 专辑封面 + 进度条 + 播放控制, 适配视频叠加 / 个人主页」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

【Template: Spotify Now-Playing Card】
【Intent】Render a song, a podcast episode, or a personal bio as a Spotify Now Playing card, suited to a video overlay / personal about page / creator hero. Inspired by html-frames spotify-card.

【Canvas】Two sizes:
- Landscape video overlay: 1280×720, card centered or floating bottom-left.
- Compact horizontal widget: 600×200, embeddable in any hero.

【Card structure】
- Frame: 12-16px corner radius; bg uses a dark gradient sampled from the album art color (e.g. `linear-gradient(135deg, #1e3264 0%, #0d1f3d 100%)`) or the classic Spotify `#121212`; a 1px subtle border on the edge.
- Left side: **album art** (CSS gradient + large monogram or abstract geometric illustration, no external image links), 6px corner radius, 60-200px square.
- Right side:
  - Top `NOW PLAYING` (uppercase letterspace 0.14em, 11px, green `#1DB954`).
  - **Track name / title** (Inter / Spotify Circular, 22-28px, weight 700, white).
  - **Artist / subtitle** (16px, weight 400, opacity 0.7).
  - Progress bar: 4px tall, rounded, gray background + white fill (`width: 38%`); timestamps at both ends `1:24 / 3:42` (mono, 11px, gray).
  - Control row: ⏮ ⏯ ⏭ icons (inline SVG, 24px, white fill), shuffle / repeat icons smaller.
- Top right: Spotify logo (inline SVG, green `#1DB954` circle + three white sound-wave arcs).
- Optional: small animated sound-wave bars bottom right (3 bars, `@keyframes`).

【Typography】
- Primary: `Spotify Circular` → fallback `Inter` / `Inter Tight`, weight 400 / 700.
- Numerals: same primary font, avoid overusing mono.

【Design details】
- Classic Spotify dark mode: `#121212` bg, `#1DB954` accent, `#b3b3b3` secondary text.
- If the user's input is text/a title → treat the "title" as the track name, the "subtitle/author" as the artist, and estimate a default "duration" of 3:42.
- If the user's input is music-related → map it directly.
- No external image links; use CSS gradients + a text logo / geometric illustration for the cover.
- Micro-animation: sound-wave animation uses `@keyframes`, can be disabled via `prefers-reduced-motion`.
- Single-file HTML.
