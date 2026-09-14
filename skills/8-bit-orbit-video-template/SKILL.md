---
name: 8-bit-orbit-video-template
description: |
  Hyperframes-based video template for retro pixel deck motion design.
  Use when users want a high-fidelity, multi-scene HTML-to-video composition
  with advanced transitions, interactive preview controls, and ready-to-render
  default style.
triggers:
  - "hyperframes video template"
  - "video template"
  - "pixel motion deck"
  - "retro presentation video"
  - "Hyperframes template"
  - "video template"
  - "pixel-art motion"
readable:
  mode: template
  surface: video
  type: hyperframes
  platform: desktop
  preview:
    type: html
    entry: example.html
    reload: debounce-100
  design_system:
    requires: false
  outputs:
    primary: index.html
    secondary:
      - template.html
      - example.html
  example_prompt: "Create a 3-page Hyperframes video deck in 8-bit retro style with advanced transitions, rich motion, and each page under 3 seconds."
  capabilities_required:
    - file_write
---

# Hyperframes Video Template

Ship a premium template-mode Hyperframes composition with a ready default showcase and deterministic timeline behavior.

## Resource map

```text
8-bit-orbit-video-template/
├── SKILL.md
├── assets/
│   └── template.html
├── references/
│   └── checklist.md
└── example.html
```

The rendered MP4 showcase used by `example.html` is hosted at
`https://repo-assets.readable-studio.ai/resources/videos/skills/8-bit-orbit-video-template/default-showcase.mp4`.

## Workflow

1. Copy `assets/template.html` to `index.html`.
2. Keep the 3-scene structure and transition rhythm intact unless the user explicitly asks to change pacing.
3. Personalize titles, subtitle lines, labels, and palette while preserving the retro pixel aesthetic.
4. Keep timing constraint: every scene hold should stay within 3 seconds.
5. Preserve deterministic behavior in generated compositions (no unseeded randomness, no infinite GSAP loops).
6. Keep all code self-contained in one HTML file with inline CSS/JS.
7. Validate against `references/checklist.md` before finishing delivery.

## Output contract

With file tools, save or edit `index.html`; the saved file is the deliverable. Finish with a brief reference to that file and a summary of the change. Keep the user's topic in the document title.

<readable-delivery channel="no-file-tools">
Only without file tools, use this chat delivery channel with the stable identifier `index` and the user's topic in `title`:

Emit one short sentence before the artifact, then a single HTML artifact:

```xml
<artifact identifier="index" type="text/html" title="8-Bit Orbit Video Template">
<!doctype html>
<html>...</html>
</artifact>
```
</readable-delivery>
