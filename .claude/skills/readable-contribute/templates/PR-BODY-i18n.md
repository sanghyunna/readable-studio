## What this PR translates

**{{DOC_NAME}}** → **{{LANG_DISPLAY_NAME}}** (`{{LANG_CODE}}`)

- New file: `{{TRANSLATED_PATH}}`
- Source: `{{ENGLISH_PATH}}`
- Status: {{STATUS}}  <!-- "missing" (new translation) or "stale" (refreshed) -->

## What I preserved

- Every Markdown structure element (headings, lists, tables, callouts, link/image targets)
- Code blocks — left untranslated
- Brand names and product names — left untranslated
- Internal cross-links — adjusted to point to the localized file when one exists, else to the English source

## What I changed

{{TRANSLATION_NOTES}}

## How to verify

```bash
# Render preview locally
cd readable-studio
# (or just open the .md file in any Markdown viewer)
```

## Checklist

- [x] Markdown parses cleanly (code fences balanced, no broken structure)
- [x] All relative links and image paths still resolve
- [x] External links return 2xx/3xx
- [ ] Maintainer review

---

👋 This is my first Readable Studio contribution. I'm a native {{LANG_DISPLAY_NAME}} speaker (or close to it!) and want to help Readable Studio reach more people in my language.

If you want to chat or you're another translator reading this, come find us in the Readable Studio Discord: {{DISCORD_INVITE}}

_Generated with the `readable-contribute` skill._
