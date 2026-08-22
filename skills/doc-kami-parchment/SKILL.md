---
name: doc-kami-parchment
zh_name: "Kami 羊皮纸文档"
en_name: "Kami Parchment Document"
emoji: "📜"
description: "Warm parchment canvas (#f5f4ed), monochrome ink-blue accent (#1B365D), one serif family, and editorial-grade typography."
zh_description: "暖羊皮纸底 (#f5f4ed) + 墨蓝单色 accent (#1B365D) + 单一衬线字体, 编辑级排印"
en_description: "Warm parchment canvas (#f5f4ed), monochrome ink-blue accent (#1B365D), one serif family, and editorial-grade typography."
category: doc
scenario: personal
aspect_hint: "A4 / Letter long page"
featured: 48
recommended: 3
tags: ["kami", "parchment", "serif", "editorial", "report", "letter", "one-pager"]
example_id: sample-kami-parchment
example_name: "Kami Parchment · One-Pager"
example_format: markdown
example_tagline: "Warm parchment, monochrome ink blue, and one serif"
example_desc: "An editorial one-pager for Readable Studio Studio Issue No. 26"
example_source_url: "https://github.com/tw93/kami"
example_source_label: "tw93/kami"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: personal
  featured: 0.04
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Kami Parchment Document template to turn my content into a warm parchment document with monochrome ink-blue accents, one serif family, and editorial-grade typography. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「Kami 羊皮纸文档」模板把我的内容做成一份「暖羊皮纸底 (#f5f4ed) + 墨蓝单色 accent (#1B365D) + 单一衬线字体, 编辑级排印」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

## Kami Parchment Document

Use this template for composed one-pagers, long reports, letters, resumes, portfolios, slides, equity reports, and changelogs; it should read as typeset paper, never a dashboard.

- Use parchment `#f5f4ed`, secondary `#efeee5`, warm ink `#1f1d18`, secondary ink `#6b665b`, and one accent only: ink blue `#1B365D`.
- Use Charter (with Source Serif Pro or Iowan Old Style fallbacks) for Latin text, a matching serif for any additional script, body weight 400, heading weight 500, and 1.1–1.3 heading / 1.4–1.55 body leading.
- Avoid pure white and black, gradients, neon, blur, drop shadows, large corner radii, and alpha backgrounds. Use solid color tags, simple geometric icons, and restrained `#d4d1c5` hairline rules.
- Select the document form from the user content: header and columns for a one-pager; cover, contents, folios, and colophon for long docs; conventional metadata for letters, resumes, and equity reports; or a minimal printed-page feeling for slides.
- Use one HTML file with Tailwind CDN, preserve whitespace-based hierarchy, and use paper-tint outlined blocks instead of linked placeholder images.
