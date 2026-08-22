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
example_tagline: "Inspired by a post from @trq212"
example_desc: "An extended essay on HTML over Markdown, with an attribution and linked source"
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

## Magazine Article

- Start with a `text-5xl` or `text-6xl` hero title, optional subtitle, and author, reading-time, and date metadata.
- Use a centered single column around 700px wide with `text-lg leading-relaxed text-neutral-700 dark:text-neutral-300` paragraphs.
- Use serif H2 and H3 headings, italic block quotes with a heavy accent rule, and dark rounded code blocks with a language label.
- Use custom square or accent-dot list markers and a centered ornamental `<hr>` between sections.
- Finish with a concise share call to action.
