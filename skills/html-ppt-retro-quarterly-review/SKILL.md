---
name: html-ppt-retro-quarterly-review
description: |
  Retro Quarterly Review presentation template in a bold blue + orange editorial
  language. Use when users ask for a high-impact quarterly review / roadmap deck
  with heavyweight slab headlines, clean cream paper sections, structured grids,
  and fast premium motion pacing (3 slides, each hold under 3s in video mode).
triggers:
  - "retro quarterly review"
  - "quarterly review template"
  - "roadmap slide style"
  - "blue orange presentation"
  - "vintage business deck"
  - "retro quarterly review"
  - "blue orange retro report template"
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
  capabilities_required:
    - file_write
---

# Retro Quarterly Review Template

A high-contrast, print-inspired quarterly review template with three cinematic
slides:

1. Cover (hero title lockup)
2. Three priorities (triptych grid)
3. Roadmap timeline + KPI strip

## Resource map

```text
html-ppt-retro-quarterly-review/
├── SKILL.md
├── assets/
│   └── template.html
├── references/
│   └── checklist.md
└── example.html
```

## Workflow

1. Read active `DESIGN.md` first and map any requested token changes into CSS
   variables while preserving the retro blue/orange/cream visual grammar.
2. Start from `assets/template.html`; do not rebuild from scratch.
3. Preserve the three-slide information architecture and typographic hierarchy.
4. Keep interactions and motion quality:
   - keyboard `1/2/3` quick jump
   - `R` restart
   - page indicator updates per scene
   - premium wipe transitions and staggered reveals
5. Keep output self-contained (single HTML, inline CSS + JS, no framework runtime).
6. If adapting copy/data, keep content realistic and internally consistent.
7. Validate against `references/checklist.md` before finishing delivery.

## Output contract

With file tools, save or edit `index.html`; the saved file is the deliverable. Finish with a brief reference to that file and a summary of the change. Keep the user's topic in the document title.

<readable-delivery channel="no-file-tools">
Only without file tools, use this chat delivery channel with the stable identifier `index` and the user's topic in `title`:

Emit one short orientation sentence and then the artifact:

```xml
<artifact identifier="index" type="text/html" title="Retro Quarterly Review">
<!doctype html>
<html>...</html>
</artifact>
```
</readable-delivery>
