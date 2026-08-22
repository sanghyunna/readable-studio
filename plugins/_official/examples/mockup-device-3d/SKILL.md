---
name: mockup-device-3d
zh_name: "iPhone × MacBook 立体展架"
en_name: "Device 3D Showcase"
emoji: "📱"
description: "Static iPhone and MacBook 3D-style showcase with real HTML embedded on screens, glass-lens refraction, and 360-degree turntable composition."
zh_description: "iPhone + MacBook 仿 GLTF 静态展架, 屏幕内嵌真实 HTML 内容, 玻璃镜头折射, 360° 转盘构图"
en_description: "Static iPhone and MacBook 3D-style showcase with real HTML embedded on screens, glass-lens refraction, and 360-degree turntable composition."
category: poster
scenario: product
aspect_hint: "1920×1080 (16:9)"
featured: 47
tags: ["device", "mockup", "iphone", "macbook", "html-in-canvas", "product"]
example_id: sample-mockup-device-3d
example_name: "Device 3D Showcase"
example_format: markdown
example_tagline: "HTML-in-Canvas Device Showcase"
example_desc: "iPhone screen and MacBook screen both embed real UI content, with glass-lens refraction"
example_source_url: "https://github.com/nexu-io/html-anything"
example_source_label: "html-frames · vfx-iphone-device"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: product
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Device 3D Showcase template to turn my content into a static iPhone and MacBook 3D-style showcase with real HTML embedded on the screens. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「iPhone × MacBook 立体展架」模板把我的内容做成一份「iPhone + MacBook 仿 GLTF 静态展架, 屏幕内嵌真实 HTML 内容, 玻璃镜头折射, 360° 转盘构图」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

[Template: Device 3D Showcase (Device 3D Showcase / HTML-in-Canvas)]
[Intent] Product launches, app demos, design mockup showcases. Render the user's provided UI content for real inside an iPhone / MacBook "screen", with CSS 3D transforms around it simulating the glass / highlight / refraction of a GLTF model. Inspired by html-frames vfx-iphone-device.

[Hard composition rules]
- **Canvas**: 1920×1080, warm gray gradient background `radial-gradient(#1a1a1f → #0a0a0f)`, reflective mirror ground at the bottom (mirror gradient).
- **iPhone 15 Pro model**: left / center, `transform: rotateY(-12deg) rotateX(4deg) translateZ(40px)`; titanium-silver border `#a8a8ad` (solid 4px) + 56px screen corner radius; an iframe-like div embedded in the screen that renders the user's actual HTML content (mobile viewport 375×812).
- **MacBook Pro 14"** (optional second device): right side, slightly smaller, `rotateY(8deg)`; the lid screen embeds desktop viewport content (1440×900 scaled); the base keyboard + trackpad are drawn with CSS shadow lines (no individual keycap detail).
- **Glass / lens flare**: add 2-3 elliptical highlights at the top using `radial-gradient(ellipse, rgba(255,255,255,0.4) 0%, transparent 60%)` to simulate a morphing glass lens.
- **Ground reflection**: below the device, `transform: scaleY(-1)` + `mask-image: linear-gradient(to bottom, rgba(0,0,0,0.4), transparent 70%)`.

[Screen content source]
- If the user provides text/data → auto-render it as a mock app interface (top status bar + title + body + bottom tab bar or home indicator).
- If the user provides HTML → embed it as-is inside the screen div (apply a scale transform so it fits the screen's width/height).
- Screen UI uses Tailwind, with font sizes at real mobile scale (text-sm / text-base, not text-9xl).

[Optional extras]
- Bottom-right "product slug" badge: a large logo + one line of tagline + a hairline subtitle.
- A top caption line (English sans-serif, small size, 0.6 opacity): product codename / date / version.
- An 8s auto CSS turntable animation: `@keyframes turntable` rotateY -12 ↔ 12, ease-in-out infinite alternate; can be disabled via `prefers-reduced-motion`.

[Design details]
- **Never**: use external mockup image URLs (any unsplash / dribbble link) — draw the device entirely with CSS / SVG.
- Fonts: captions/logo outside the device use an `Inter Tight` / `SF Pro` style; content inside the device adapts to whatever the user provides.
- Background: choose from 4 color palettes — charcoal / pearl / midnight blue / mocha; no rainbow gradients.
- Single-file HTML; don't nest iframes via srcdoc (prone to issues) — use `<div class="screen">` + Tailwind to render content.
- Screen content must be filled with the user's real data; lorem ipsum or "Your text here" placeholders are strictly forbidden.
