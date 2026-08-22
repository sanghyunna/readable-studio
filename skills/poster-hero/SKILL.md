---
name: poster-hero
zh_name: "营销海报"
en_name: "Marketing Poster"
emoji: "🖼️"
description: "Vertical poster or Moments-style share image with strong visual impact."
zh_description: "竖版海报 / 朋友圈分享图, 强视觉冲击"
en_description: "Vertical poster or Moments-style share image with strong visual impact."
category: poster
scenario: marketing
aspect_hint: "1080×1920 vertical"
tags: ["poster", "marketing", "social share"]
example_id: sample-poster-launch
example_name: "Marketing Poster · Product launch"
example_format: markdown
example_tagline: "A 9:16 social share image"
example_desc: "A high-contrast launch poster with a QR placeholder, gradient mesh, and grain texture"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: marketing
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Marketing Poster template to turn my content into a vertical poster or Moments-style share image with strong visual impact. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「营销海报」模板把我的内容做成一份「竖版海报 / 朋友圈分享图, 强视觉冲击」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

# Marketing Poster

- Use a `w-[1080px] h-[1920px] mx-auto` canvas with a full-frame gradient or mesh background.
- Reserve roughly 30% whitespace at the top for one large emoji or abstract geometric element.
- Put the primary headline at the visual center (`text-8xl`, `font-black`) with a one-sentence subtitle.
- Use a lower information card for three to five key points with icons and short copy.
- Place the brand and an SVG QR-code placeholder at the bottom-right.
- Use bold color: a gradient such as `from-violet-500 via-fuchsia-500 to-indigo-500`, white type, and one contrasting highlight color.
- Build decorative circles, triangles, waves, and grain with SVG.
