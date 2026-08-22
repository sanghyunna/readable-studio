---
name: article-magazine
zh_name: "杂志文章"
en_name: "Magazine Article"
emoji: "📖"
description: "Huashu / huashu-md-html-inspired magazine article layout for turning Markdown or notes into a polished long-form HTML essay."
zh_description: "Huashu / huashu-md-html 风格杂志文章版式, 将 Markdown 或笔记转成精排长文 HTML。"
en_description: "Huashu / huashu-md-html-inspired magazine article layout for turning Markdown or notes into a polished long-form HTML essay."
category: article
scenario: marketing
aspect_hint: "A4 / long page"
featured: 11
tags: ["blog", "essay", "newsletter", "article"]
example_id: sample-article-trq212-html
example_name: "Magazine Article · HTML Replaces Markdown"
example_format: markdown
example_tagline: "Inspired by @trq212's tweet"
example_desc: "An extended commentary on 'in the AI era, HTML > Markdown', with annotations on the original tweet and clickable links"
example_source_url: "https://x.com/trq212/status/2052809885763747935"
example_source_label: "@trq212 / x.com"
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
  example_prompt: "Use the Magazine Article template to turn my content into a Huashu / huashu-md-html-inspired long-form HTML essay. Preserve the template's visual signature, use real content and data, and avoid lorem ipsum or placeholder images."
  example_prompt_i18n:
    zh-CN: "用「杂志文章」模板把我的内容做成一份「Huashu / huashu-md-html-inspired magazine article layout for turning Markdown or notes into a polished long-form HTML essay」。保持模板的视觉签名，使用真实内容和数据，避免 lorem ipsum 和占位图片。"
---

【Template: Magazine Article】
- Top hero: large title (text-5xl/6xl) + optional subtitle + author / reading time / date metadata.
- Body: single column, max width ~700px, centered. Paragraphs `text-lg leading-relaxed text-neutral-700 dark:text-neutral-300`.
- H2 / H3 headings use a serif font, creating visual contrast with the body text.
- Blockquotes use a thick accent-colored left border + italics.
- Code blocks: rounded corners + dark background + light text, with a language label shown.
- List items use custom bullets (small squares / accent-colored dots).
- Sections are separated by `<hr>`, styled as a small centered ornament.
- End the article with a simple "If you found this useful, please share" call-to-action card.
