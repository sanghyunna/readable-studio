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
aspect_hint: "A4 / Letter, long page"
featured: 48
recommended: 3
tags: ["kami", "parchment", "serif", "editorial", "report", "letter", "one-pager"]
example_id: sample-kami-parchment
example_name: "Kami Parchment · One-Pager"
example_format: markdown
example_tagline: "Warm parchment + ink-blue monochrome + single serif"
example_desc: "A one-page editorial-grade one-pager, Readable Studio Studio Issue No. 26"
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

[Template: Kami Parchment Document]
[Intent] Serious typeset documents: one-pager / long report / letter / resume / financial report / changelog / portfolio. Inspired by tw93/kami. Emphasizes "written like typeset paper", not a dashboard, not a webpage.

[Hard visual signature — do not change]
- **Canvas**: warm parchment `#f5f4ed` (never pure white `#fff`). Secondary background `#efeee5`.
- **Ink**: primary text `#1f1d18` (near-black warm gray, not pure black `#000`). Secondary text `#6b665b`.
- **Single accent color**: ink blue `#1B365D` — every accent (links, tag outlines, highlighted numbers, quote left rule) uses only this one color, no other colors allowed.
- **Fonts**: one serif per language, never mixed within the same text:
  - English: `Charter` (fallback: `Source Serif Pro`, `Iowan Old Style`)
  - Chinese: `TsangerJinKai02 W04` (fallback: `Noto Serif SC`)
  - Japanese: `YuMincho` (fallback: `Noto Serif JP`)
  - Body 400, Heading 500 (no 700/800/900).
- **Line height**: headings 1.1–1.3, tight body 1.4–1.45, reading-style body 1.5–1.55.
- **Never**: drop-shadow / blur / border-radius >= 8px / gradients / neon colors / rgba (use solid hex).
- **Details**: tags use solid hex background blocks (because WeasyPrint doesn't render rgba well); single-stroke geometric icons; edge 1px hairline `#d4d1c5` rule, controlled length that doesn't reach the edge.

[Optional document types — choose based on user content]
- **One-Pager** — top logotype (Charter italic) + title + lede + 3-column key points + footer metadata.
- **Long Doc** — cover page (large title + subtitle + author + date) -> table of contents (kicker + page no.) -> chapters (folio corner + section rule + body) -> annotation footnotes + colophon at the end.
- **Letter** — letterhead address + date + recipient + body (left-aligned, 1.5em paragraph spacing) + signature + signature placeholder line.
- **Portfolio** — project hero (large title + sub) + 1 full-width image (drawn as a CSS block placeholder) + project description + role / time / stack metadata row.
- **Resume** — name at top (large text) + one-line tagline + contact row + main sections: experience (company / time / role / bullets) + skills + education.
- **Slides** — keynote style, page count determined by [user content] (short content starts at 6 pages, longer content should have more), each page fills the parchment, large title + lede + corner page no., kept simple enough to feel "printed".
- **Equity Report** — company name + ticker + Q x year + key metrics row (revenue / margin / yoy) + body analysis + chart (monochrome SVG line chart).
- **Changelog** — version number (large Charter italic) + date + change list (Added / Changed / Fixed), separated by a single rule.

[Design principles]
- "Composed pages, not dashboards." Don't stack KPI cards, don't pile on emoji icons, no hero gradients.
- "Ring or whisper only, no hard drop shadows." Shadows can only be a hairline outline like `0 0 0 1px #d4d1c5`.
- Text hierarchy relies on **serif contrast + font size + whitespace**, not color.
- Single-file HTML, using Tailwind CDN; add pangu spacing when mixing Chinese and English text; no external image links, use paper-tint color blocks + 1px ink outline for placeholders.
