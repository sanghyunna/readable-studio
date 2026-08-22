---
name: frame-flowchart-sticky
zh_name: "便利贴流程图帧"
en_name: "Sticky Flowchart Frame"
emoji: "📝"
description: "SVG curve connectors, sticky-note nodes, and cursor interaction with a whiteboard-brainstorm feel."
zh_description: "SVG 曲线连接 + 便利贴节点 + 光标交互, 像白板 brainstorm"
en_description: "SVG curve connectors, sticky-note nodes, and cursor interaction with a whiteboard-brainstorm feel."
category: video
scenario: operations
aspect_hint: "1920×1080 (16:9)"
featured: 45
tags: ["flowchart", "diagram", "sticky", "whiteboard", "frame"]
example_id: sample-frame-flowchart-sticky
example_name: "Sticky Flowchart · User Onboarding"
example_format: markdown
example_tagline: "SVG curves and four-color sticky notes"
example_desc: "Six-node onboarding flow with hand lettering and a paper whiteboard"
example_source_url: "https://hyperframes.heygen.com/catalog"
example_source_label: "hyperframes · flowchart"
readable:
  mode: video
  surface: video
  scenario: operations
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Sticky Flowchart Frame template to turn my content into a whiteboard-brainstorm frame with SVG curve connectors, sticky-note nodes, and cursor interaction. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「便利贴流程图帧」模板把我的内容做成一段「SVG 曲线连接 + 便利贴节点 + 光标交互, 像白板 brainstorm」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

## Sticky Flowchart

- Use a `1920×1080` warm-paper `#f4ede1` or cool-gray `#f0f2f4` canvas with a subtle `rgba(0,0,0,0.04)` hex grid.
- Make each node a 240×180px sticky note in yellow `#fcd34d`, peach `#fca5a5`, mint `#a7f3d0`, or periwinkle `#a5b4fc`. Give notes varied ±2deg rotation, a soft drop shadow, tape decoration, an icon, title, and short description.
- Connect nodes using SVG Bezier paths with a round 2.5px `#2a2a2a` stroke. Use solid lines for flow and `8 6` dashes for conditional branches; use `marker-end` arrows.
- Use Kalam, Caveat, or Patrick Hand. Keep five to twelve nodes, avoid a rigid grid, use the supplied process text, and avoid dark backgrounds, neon, dashboard styling, and external icon libraries.
- An optional collaborator cursor may sit by a node. On hover, raise its shadow and scale to 1.05. Keep everything in one HTML file.
