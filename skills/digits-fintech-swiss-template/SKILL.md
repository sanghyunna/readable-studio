---
name: digits-fintech-swiss-template
description: |
  Swiss-grid fintech deck template in black / warm paper / neon-lime contrast.
  Use when users ask for premium data-story slides with strict modular layout,
  bold numeric cards, restrained motion, and keyboard/click navigation in one HTML file.
triggers:
  - "swiss fintech template"
  - "data-driven finance deck"
  - "neon lime editorial grid"
  - "high contrast strategy slides"
  - "Swiss fintech template"
readable:
  mode: template
  surface: video
  type: hyperframes
  platform: desktop
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  outputs:
    primary: index.html
    secondary:
      - template.html
      - example.html
  example_prompt: "Create a Swiss-grid fintech strategy deck with modular data cards, lime accents, and clean keyboard navigation."
  capabilities_required:
    - file_write
---

# Digits Fintech Swiss Template

A premium three-slide live-artifact template for data-storytelling in a Swiss grid language.

## Resource map

```text
digits-fintech-swiss-template/
├── SKILL.md
├── assets/
│   └── template.html
├── references/
│   └── checklist.md
└── example.html
```

## Workflow

1. Start from `assets/template.html` and keep the three-slide structure intact.
2. Replace copy and metric values while preserving card hierarchy and reading order.
3. Keep interactions:
   - Prev / Next buttons
   - keyboard navigation (`ArrowLeft` / `ArrowRight`)
   - dot navigation
4. Keep motion subtle (slide fade + tiny hover lift only).
5. Keep the file self-contained (inline CSS/JS) with no sandbox-hostile APIs.

## Output contract

With file tools, save or edit `index.html`; the saved file is the deliverable. Finish with a brief reference to that file and a summary of the change. Keep the user's topic in the document title.

<readable-delivery channel="no-file-tools">
Only without file tools, use this chat delivery channel with the stable identifier `index` and the user's topic in `title`:

Emit one concise orientation sentence and then one HTML artifact:

```xml
<artifact identifier="index" type="text/html" title="Digits Fintech Swiss Deck">
<!doctype html>
<html>...</html>
</artifact>
```
</readable-delivery>
