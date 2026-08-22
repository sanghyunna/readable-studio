---
name: data-report
zh_name: "数据可视化报告"
en_name: "Data Visualization Report"
emoji: "📊"
description: "Turns CSV, Excel, or JSON data into a polished visual report page."
zh_description: "把 CSV/Excel/JSON 数据转成漂亮的可视化报告页"
en_description: "Turns CSV, Excel, or JSON data into a polished visual report page."
category: data
scenario: finance
aspect_hint: "Desktop long page"
featured: 10
tags: ["data", "report", "chart", "visualization"]
example_id: sample-data-weekly-report
example_name: "Data Report · Weekly Review"
example_format: csv
example_tagline: "KPI cards, Chart.js charts, and a table"
example_desc: "Nine months of growth data rendered into a visual report with inline Chart.js"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: finance
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Data Visualization Report template to turn my CSV, Excel, or JSON data into a polished visual report page. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「数据可视化报告」模板把我的内容做成一份「把 CSV/Excel/JSON 数据转成漂亮的可视化报告页」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

## Data Visualization Report

- Lead with a title, period, and data source; then show three to five KPI cards with values, period changes, and sparklines.
- Include at least two charts based on the supplied data, using Chart.js or ECharts from jsDelivr.
- Give every canvas wrapper an explicit height: about 40px for KPI sparklines and 240–280px for main charts. With `responsive: true` and `maintainAspectRatio: false`, a wrapper without a height can trigger an unbounded ResizeObserver loop. Do not use a canvas `height` attribute for layout.
- Add a styled excerpt of source data, three to five emoji-led insights, and a collapsible methodology section.
- Use one restrained primary color plus neutrals, and never fabricate data.
