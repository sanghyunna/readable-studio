---
name: team-okrs
description: |
  OKR tracker page — quarter banner, three objectives with their key
  results as progress bars, owner avatars, status pills, and a "this
  quarter at a glance" sidebar. Use when the brief mentions "OKRs",
  "key results", "objectives", or "goals".
triggers:
  - "okr"
  - "okrs"
  - "key results"
  - "objectives"
  - "goals"
readable:
  mode: prototype
  platform: desktop
  scenario: product
  preview:
    type: html
    entry: index.html
  design_system:
    requires: true
    sections: [color, typography, layout, components]
  example_prompt: "Build an OKR tracker for Q4 — three objectives, three key results each, progress bars, owners, status pills."
---

# Team OKRs Skill

Produce a single-screen OKR tracker.

## Workflow

1. Read DESIGN.md.
2. Layout:
   - Quarter banner: Q4 FY25, dates, overall progress chip.
   - Three objective cards. Each has:
     - Objective title + owner avatar + status pill (On track / At risk / Off track)
     - 3 key results, each a row with metric / current → target / progress bar
   - Right sidebar: at-a-glance KPIs, top movers, blockers callout.
3. Clear progress visualisation, calm palette, one accent.

## Output contract

With file tools, save or edit `index.html`; the saved file is the deliverable. Finish with a brief reference to that file and a summary of the change. Keep the user's topic in the document title.

<readable-delivery channel="no-file-tools">
Only without file tools, use this chat delivery channel with the stable identifier `index` and the user's topic in `title`:

```
<artifact identifier="index" type="text/html" title="OKRs Q4">
<!doctype html>...</artifact>
```
</readable-delivery>
