---
name: swiss-creative-mode-template
description: |
  Swiss-inspired creative-mode presentation template skill with bold editorial
  typography, high-contrast geometric cards, interactive slide navigation,
  theme switching, hotspot overlays, and palette choreography in a single-file
  HTML artifact. Use when users ask for a premium presentation-style landing,
  a Swiss/brutalist deck look, or a creative launch page with rich interactions.
triggers:
  - "swiss creative mode template"
  - "editorial presentation template"
  - "brutalist deck style html"
  - "creative mode deck"
  - "Swiss presentation template"
  - "premium design-language template"
readable:
  mode: template
  surface: video
  type: hyperframes
  platform: desktop
  preview:
    type: html
    entry: index.html
    reload: debounce-100
  design_system:
    requires: true
    sections: [color, typography, layout, components]
  outputs:
    primary: index.html
    secondary:
      - template.html
      - example.html
  capabilities_required:
    - file_write
---

# Swiss Creative Mode Template

Produce a premium Swiss/editorial-style HTML template with strong visual rhythm
and meaningful interactions, then deliver it through the output contract below.

## Resource map

```text
swiss-creative-mode-template/
├── SKILL.md
├── assets/
│   └── template.html
├── references/
│   └── checklist.md
└── example.html
```

## Workflow

1. Read active `DESIGN.md` and map palette/type/layout decisions into root CSS variables.
2. Copy `assets/template.html` to `index.html`.
3. Keep this structure intact:
   - Hero scene with bold title and geometric frame.
   - Four-step process card row.
   - Stack/architecture diagram scene.
4. Keep these interactions working:
   - Prev/next slide navigation + dot nav.
   - Theme toggle (paper/dark).
   - Palette cycle button (changes accent colors across the template).
   - Hotspot toggle for annotations/details.
5. Keep output self-contained (`<!doctype html>`, inline CSS/JS, no external runtime dependency).
6. Validate against `references/checklist.md` before emitting.

## Output contract

With file tools, save or edit `index.html`; the saved file is the deliverable. Finish with a brief reference to that file and a summary of the change. Keep the user's topic in the document title.

<readable-delivery channel="no-file-tools">
Only without file tools, use this chat delivery channel with the stable identifier `index` and the user's topic in `title`:

One short sentence before artifact, then:

```xml
<artifact identifier="index" type="text/html" title="Swiss Creative Mode Template">
<!doctype html>
<html>...</html>
</artifact>
```
</readable-delivery>
