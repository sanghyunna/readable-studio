---
name: deck-swiss-international
zh_name: "瑞士国际主义 Deck"
en_name: "Swiss International Deck"
emoji: "🟦"
description: "16-column grid, one saturated accent, and 22 locked layouts (Klein Blue, Lemon, Mint, Safety Orange)."
zh_description: "16 列网格 + 单一饱和 accent + 22 个锁死版面 (Klein Blue / Lemon / Mint / Safety Orange)"
en_description: "16-column grid, one saturated accent, and 22 locked layouts (Klein Blue, Lemon, Mint, Safety Orange)."
category: slides
scenario: marketing
aspect_hint: "16:9 landscape, paginated"
featured: 1
recommended: 1
tags: ["swiss", "grid", "international", "ikb", "editorial", "facts"]
example_id: sample-swiss-international
example_name: "Swiss International · Product Roadmap"
example_format: markdown
example_tagline: "Klein Blue IKB + 16-Column Grid"
example_desc: "S01 Cover + S06 KPI Tower two-page preview, IKB full-bleed title + 4-bar KPI"
example_source_url: "https://github.com/op7418/guizang-ppt-skill"
example_source_label: "op7418/guizang-ppt-skill"
readable:
  mode: deck
  surface: web
  scenario: marketing
  featured: 0.001
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Swiss International Deck template to turn my content into a 16-column-grid deck with one saturated accent and 22 locked layouts. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「瑞士国际主义 Deck」模板把我的内容做成一套「16 列网格 + 单一饱和 accent + 22 个锁死版面 (Klein Blue / Lemon / Mint / Safety Orange)」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

[Template: Swiss Internationalism Deck (Swiss International)]
[Intent] Expression of facts, products, analysis, and methodology. Extremely calm, rational, and academic, without any hand-painting/noise/decoration. Inspired by op7418/guizang-ppt-skill Style B.

【Theme】**You can only choose one from the following 4 sets, no mixing or changing is allowed hex**:
- 🔵 **Klein Blue (IKB)** — accent `#002FA7`, paper `#fafaf8`, ink `#0a0a0a`. Business / AI / Design scenarios.
- 🟡 **Lemon Yellow** — accent `#FFD500`, paper `#f7f5ee` (light cream), ink `#0a0a0a`. Young / Retail / Sports. Text must be in black (not white).
- 🟢 **Lemon Green / Neon** — accent `#C5E803`, paper `#f7f5ee`, ink `#0a0a0a`. Sustainable / Tech Startup / Gen-Z Brand. Text must be in black.
- 🟠 **Safety Orange** — accent `#FF6B35`, paper `#f7f5ee`, ink `#0a0a0a`. Industrial / Automotive / Emergency Message. Use white + bold ≥ 600 for text.

[Layout - 22 reusable layout pools, no new or modified layouts are allowed; **The number is determined by the content**, until the [User Content] is completely covered (short content starts with 6-10 pieces, long content should far exceed this range, the same layout can be reused in different chapters)]
- **S01 Cover** — full-screen accent + ASCII breath matrix + anti-white title + metadata chrome (date / № / topic).
- **S02 Vertical Timeline** — left dashed axis + dot; right node = year + KPI + description.
- **S03 Statement** — 9.6vw Centered giant font + large blank space on the left + bottom hairline + comments.
- **S04 Six Cells** — 2×3 grid, each cell: icon + number + short title + single line description.
- **S05 Three Sub-cards** — left hero title + 3 horizontally stacked gray cards on the right.
- **S06 KPI Tower** — 4 columns become taller blue columns; icon at the top of the column; large number + label at the bottom of the column.
- **S07 H-Bar Chart** — Horizontal ranking bar, width reflects data, end marked with numbers.
- **S08 Duo Compare** — Vertical dividing line; Left Before / Right After.
- **S09 Closing Manifesto** — Left IKB block + ASCII dot matrix + manifesto; right white background + 3 bullet points.
- **S10 Dot Matrix Statement** — Centered Statement + Corner Geometric Point Matrix/Ring Matrix.
- **S11 Horizontal Timeline** — Top headline, middle hairline axis, equidistant nodes, step names below the nodes.
- **S12 Manifesto + Ink Banner** — The upper half of the headline + explanation; the lower half of the full-width black banner + reversed white text.
- **S13 Three Forces Cards** — left ink hero block; right 3 gray cards, each card: large number + text.
- **S14 Loop Diagram** — Left numbered steps; right SVG concentric loops; center "LOOP" label.
- **S15 Image Matrix + Hero Stat** — 4×3 equal height cards (12 items) + bottom summary large numbers + labels.
- **S16 Multi-card Brief** — 3×2 micro card; main text upper left, footnote lower right, single card accent highlighted.
- **S17 System Diagram** — left headline + 3 description paragraphs; right SVG three concentric circles + external label.
- **S18 Why Now** — 3 columns, each column: category label + headline + description + bottom number (last column accent).
- **S19 Four Cards** — top accent hairline + headline + 4 equal-width cards (metadata/title/text).
- **S20 Stacked KPI Ledger** — vertical rows + hairline separation; left large number / middle label / right icon.
- **S21 Tech Spec Sheet** — Left title block / Middle 3 KPI hairlines / Right high column / Bottom data.
- **S22 Image Hero** — Top 60% full width image + white title block overlay; bottom 40% explanation + 3 columns of KPIs.

[Design details—absolute iron law]
- **Right angles only**: `border-radius: 0` throughout. Rounded corners = immediate violation.
- **1px hairline borders**, black or accent; shadows/gradients/blur are strictly prohibited.
- **16 column grid**: `grid-template-columns: repeat(16, 1fr); gap: 0`.
- **Font**: Inter Tight (Latin display) / Inter (body) / Noto Sans SC (Chinese) / JetBrains Mono (data); serifs and decorative fonts are strictly prohibited.
- **Extreme contrast in font size**: cover uses 9.6vw display, body 14-16px, label 11px uppercase letterspacing 0.08em.
- **Keyboard ← / → switch + hash synchronization**; Fixed corner markers: `№N/N` bottom right, topic label bottom left.
- **No Making Up**: Numbers must come from user input, chart bar height = real data to scale.
- Output single file HTML, without any external image URL; decorative geometry (ASCII matrix / concentric circles) with pure CSS or inline SVG.
