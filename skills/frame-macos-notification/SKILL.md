---
name: frame-macos-notification
zh_name: "macOS 通知横幅"
en_name: "macOS Notification Banner"
emoji: "🔔"
description: "Realistic macOS notification banner with app icon, title, and body, suited to video overlays or product teasers."
zh_description: "拟真 macOS 通知 banner + app icon + 标题正文, 适合 video overlay / 产品发布预告"
en_description: "Realistic macOS notification banner with app icon, title, and body, suited to video overlays or product teasers."
category: card
scenario: video
aspect_hint: "1920×1080 video or 480×120 banner"
featured: 41
tags: ["macos", "notification", "banner", "overlay", "frame"]
example_id: sample-frame-macos-notification
example_name: "macOS Notification · New Feature"
example_format: markdown
example_tagline: "Big Sur frosted-glass banner"
example_desc: "App icon, title, and two-line body for a video-corner overlay"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · macos-notification"
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
  example_prompt: "Use the macOS Notification Banner template to turn my content into a realistic macOS notification banner for a video overlay or product teaser. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「macOS 通知横幅」模板把我的内容做成一段「拟真 macOS 通知 banner + app icon + 标题正文, 适合 video overlay / 产品发布预告」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

## macOS Notification Banner

- Use either a `1920×1080` composition with the banner at upper right or a centered `480×120` standalone banner.
- Use a 14px rounded frosted-glass shell: `rgba(245,245,247,0.78)`, `backdrop-filter: blur(40px) saturate(180%)`, or the dark equivalent. Add a subtle border, highlight, and shadow.
- Place a 44px CSS-gradient or monogram app icon at left. The content area has app name/time, a one-line title, and one or two body lines; an optional capsule action sits at right.
- Use SF Pro Text with Inter/system-ui fallbacks. Use a Unicode emoji or CSS geometry rather than a linked icon image.
- Optional stacked notifications recede with `scale(0.96)`, opacity, and `translateY`. Animate entrance from the right over 200ms ease-out and honor `prefers-reduced-motion`.
- Use supplied message content, support light and dark modes, prefix `backdrop-filter` for Safari, and keep the artifact to one HTML file.
