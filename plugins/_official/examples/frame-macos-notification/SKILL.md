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
aspect_hint: "1920x1080 video or 480x120 banner"
featured: 41
tags: ["macos", "notification", "banner", "overlay", "frame"]
example_id: sample-frame-macos-notification
example_name: "macOS Notification · New Feature Launch"
example_format: markdown
example_tagline: "Big Sur frosted-glass banner"
example_desc: "App icon + title + two-line body, for video corner overlay"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · macos-notification"
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

[Template: macOS notification banner]
[Intent] Render an announcement/message/prompt into a macOS Big Sur+ style notification banner, suitable for video corner overlays, product release trailers, and social media graphics. Inspired by html-frames macos-notification.

[Canvas] Two usages:
- Video overlay 1920×1080, notification placed in the upper right corner, surrounded by transparency.
- Single banner 480×120, centered output.

【Banner structure】
- Border: 14px rounded corners (macOS Big Sur standard), 480×120 (or longer 480×180 including text), 12-16px padding.
- Background: **frosted glass** effect — `background: rgba(245,245,247,0.78)` + `backdrop-filter: blur(40px) saturate(180%)`; dark version `rgba(28,28,30,0.78)`.
- Border: 1px `rgba(0,0,0,0.06)` (light) / `rgba(255,255,255,0.08)` (dark); Add 1px light highlight `rgba(255,255,255,0.5)` on top.
- Shadow: `0 10px 40px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)`.

【Content】
- Left side: **App icon** (44×44, rounded corners 10px, CSS gradient + 1 emoji or monogram letter, **No external link image**).
- middle:
  - Top row: App name (SF Pro 13px, weight 600) + `now` or specific time (12px, opacity 0.6) — justified.
  - Title (15px, weight 600, 1 line truncated).
  - Text (13px, weight 400, 1-2 line truncation, line-height 1.35).
- Right side (optional): action button "Open" or "Reply" (capsule, light gray background).

【Font】
- Main: `SF Pro Text` → fallback `Inter` / `system-ui`; Chinese uses `PingFang SC` / `Noto Sans SC`.

[Optional extra]
- Multiple notifications are stacked: the first one is in front, and the next two notifications are scaled backwards and downwards (scale 0.96 + opacity 0.6 + translateY).
- Entrance animation: slide in from the right side of the screen `transform: translateX(110%)→0`, 200ms ease-out; can be turned off by `prefers-reduced-motion`.
- The upper right corner controls chip "Clear" (hover display, opacity default 0).

【Design details】
- light mode has a white matte background, dark mode (recommended video) has an almost black matte.
- The icon cannot use external emoji images, and use unicode emoji or CSS to draw geometry.
- Must use user-supplied content; title + body clearly come from user input.
- Single file HTML, note that `backdrop-filter` Safari requires the `-webkit-` prefix.
