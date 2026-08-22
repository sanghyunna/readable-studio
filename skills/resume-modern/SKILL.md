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
tags: ["resume", "cv", "modern"]
example_id: sample-resume-frontend
example_name: "Modern Resume · Frontend Engineer"
example_format: markdown
example_tagline: "Single A4 page, print or PDF ready"
example_desc: "Senior frontend engineer resume with a two-column layout and quantified achievements"
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

# Modern Minimal Resume

- Use an A4-sized container: `w-[210mm] min-h-[297mm] mx-auto`, with 16–20mm padding.
- Set a large name (`text-4xl`) above a contact row for email, phone, city, GitHub, and LinkedIn; separate items with thin dividers.
- Use a two-column body when useful: 60% for experience, projects, and education; 40% for skills, languages, and awards.
- Give section titles a small-caps feel with a short accent rule. Each role includes company, title, right-aligned dates, and one to three verb-led bullets.
- Keep colors restrained: black, white, gray, and one accent such as deep blue or forest green. Add print styles that hide unnecessary UI and preserve color.
