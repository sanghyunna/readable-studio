---
name: resume-modern
zh_name: "极简简历"
en_name: "Modern Resume"
emoji: "📄"
description: "Modern minimal resume, single A4 page, ready for print or PDF export."
zh_description: "现代极简简历, A4 单页, 适合打印或导出 PDF"
en_description: "Modern minimal resume, single A4 page, ready for print or PDF export."
category: resume
scenario: personal
aspect_hint: "A4 (210×297mm)"
recommended: 12
tags: ["resume", "cv", "resume"]
example_id: sample-resume-frontend
example_name: "Minimalist Resume · Frontend Engineer"
example_format: markdown
example_tagline: "A4 single page, printable / PDF export"
example_desc: "Senior frontend engineer resume, two-column layout, highlighted quantified achievements"
readable:
  mode: prototype
  surface: web
  platform: desktop
  scenario: personal
  upstream: "https://github.com/nexu-io/html-anything"
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: false
  example_prompt: "Use the Modern Resume template to turn my content into a modern minimal single-page A4 resume ready for print or PDF export. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「极简简历」模板把我的内容做成一份「现代极简简历, A4 单页, 适合打印或导出 PDF」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

【Template: Modern Minimal Resume】
- Container width simulates A4: `w-[210mm] min-h-[297mm] mx-auto`, 16-20mm padding.
- Large name at the top (text-4xl), a single contact line below (email / phone / city / GitHub / LinkedIn) separated by thin vertical dividers.
- Optional two-column body: left 60% main line (experience/projects/education), right 40% secondary line (skills/languages/awards).
- Section headings: small caps style, with a short accent line above (w-8 h-0.5).
- Each experience entry: company + title + date range (right-aligned), followed by 1-3 bullets starting with action verbs.
- No flashy colors — black/white/gray plus one accent color (deep blue / dark green).
- Add `@media print` styles, hide unnecessary elements, keep colors.
