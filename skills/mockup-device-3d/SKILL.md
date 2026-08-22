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
example_name: "iPhone × MacBook 3D showcase"
example_format: markdown
example_tagline: "HTML-in-Canvas device showcase"
example_desc: "Real UI embedded on both an iPhone and MacBook screen with glass refraction"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · vfx-iphone-device"
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

# Device 3D Showcase

Use a 1920×1080 warm-dark gradient canvas and CSS 3D transforms to present a real user interface inside an iPhone 15 Pro, optionally paired with a smaller MacBook Pro. Use a solid titanium-silver 4px device frame, rounded screen corners, CSS-highlight glass refraction, and a mirrored floor reflection.

- Render supplied text/data as a realistic mock app, or embed supplied HTML directly in the screen `div`; size mobile text as mobile UI, not as a poster.
- Use CSS and SVG to draw devices. Do not use external mockup imagery or nested `srcdoc` iframes.
- Optional details: a product-slug badge, a small English sans-serif caption, and a turntable animation that respects `prefers-reduced-motion`.
- Use charcoal, pearl, midnight blue, or mocha palettes. Avoid rainbow gradients.
- Fill every screen with real user data; never use placeholder text.
