---
name: example-report
description: |
  Flexible long-form report document for any business or technical topic.
  Builds a single-file, flowing HTML report with a title block, executive
  summary, body sections, tables, chart blocks, and appendix.
triggers:
  - "report"
  - "business report"
  - "technical report"
  - "research report"
  - "status report"
  - "market analysis"
readable:
  mode: prototype
  scenario: report
  preview:
    type: html
    entry: index.html
  design_system:
    requires: true
    sections: [color, typography, layout, components]
---

# Report Skill

Produce a single-file, flowing HTML report. This is a document, not a deck:
it scrolls vertically, reads top to bottom, and prints cleanly to A4 portrait
pages.

## Resource map

```
example-report/
|-- SKILL.md
|-- assets/
|   `-- template.html       seed document with print CSS
`-- references/
    |-- layouts.md          paste-ready report sections
    `-- checklist.md        P0/P1/P2 self-review
```

## Workflow

### Step 0 - Pre-flight

1. Read `assets/template.html` end to end, especially the `:root` tokens and
   print rules.
2. Read `references/layouts.md` and choose only the sections the brief needs.
3. Read the active `DESIGN.md` and map its color, type, spacing, and component
   rules onto the template tokens.

### Step 1 - Copy the seed

Copy `assets/template.html` to the output HTML file, usually `index.html`.
Replace the document title, metadata, and placeholder copy. Keep the file
self-contained: inline CSS, no external fonts, no remote scripts.

### Step 2 - Structure the report

Use this order unless the brief clearly says otherwise:

1. Cover/title block: report type, title, audience, author, date, status.
2. Executive summary: 3-5 concrete findings or recommendations.
3. Body sections: headings, short paragraphs, subheads, and evidence.
4. Tables: readable, labelled, and narrow enough for print.
5. Chart blocks: inline SVG, CSS bars, or a clearly labelled placeholder when
   data is not available.
6. Appendix: assumptions, methodology, references, or next steps.

Short reports can use two body sections. Medium reports should use three to
five. Long reports can add page breaks between major chapters.

### Step 3 - Keep it topic-agnostic

The same skeleton must work for business and technical subjects. Change nouns,
evidence, table columns, and chart labels to match the topic; do not bake in
finance-only, sales-only, or engineering-only language unless the brief asks.

Use real details from the user prompt. If data is missing, label the numbers as
illustrative or remove the metric.

### Step 4 - Honor the design system

Bind template variables to the active design system:

- `--bg`, `--paper`, `--ink`, `--muted`, `--line`, `--accent`
- `--font-display`, `--font-body`, `--font-mono`
- spacing and border radius should follow the project tone

Keep the measure readable. Long prose should stay around 62-76 characters per
line. Tables can be wider, but they must remain legible in print.

### Step 5 - Self-check

Run through `references/checklist.md` before emitting. P0 items must pass:
complete structure, clean heading hierarchy, legible tables, print pagination,
and no external dependencies.

## Output contract

```
<artifact identifier="report-slug" type="text/html" title="Report Title">
<!doctype html>
<html>...</html>
</artifact>
```

One sentence before the artifact. Stop after `</artifact>`.

## Hard rules

- Vertical scroll only. No slide/deck navigation.
- A4 portrait print CSS must remain in the file.
- No external scripts, fonts, or images.
- Every table has a caption or nearby label.
- Every chart block has a title, units, and source or assumption note.
- No lorem ipsum. Replace or delete placeholders.
