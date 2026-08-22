# Report quality checklist

Run this before emitting the HTML artifact. P0 must pass.

## P0 - must pass

- [ ] The output is one self-contained HTML file with inline CSS.
- [ ] The document flows vertically; no deck, slide, carousel, or live-artifact behavior.
- [ ] The title block names the topic, audience, author/source, date, and status.
- [ ] The executive summary gives the conclusion or recommendation in plain language.
- [ ] Body sections use one `h1`, ordered `h2` headings, and useful subheads.
- [ ] Tables have labels/captions, readable columns, and right-aligned numerics.
- [ ] Chart blocks have title, units, source or assumption note, and accessible description.
- [ ] A4 portrait print CSS is present with `@page` and clean page breaks.
- [ ] No external scripts, fonts, images, or CDN dependencies.
- [ ] No lorem ipsum, fake citations, or unexplained invented metrics.

## P1 - should pass

- [ ] Prose measure stays readable, about 62-76 characters for long paragraphs.
- [ ] Long reports use `.page-break` before appendices or major chapters.
- [ ] The report works for the requested domain; no finance-only or engineering-only residue.
- [ ] Design tokens are mapped from the active design system instead of raw ad hoc colors.
- [ ] Accent color is used sparingly for hierarchy, not decoration.
- [ ] The mobile layout stacks without horizontal scrolling except inside unavoidable tables.
- [ ] Print output keeps headings with their following content when practical.

## P2 - nice to have

- [ ] Appendix separates assumptions, methods, and references.
- [ ] Repeated section labels use a consistent numbering scheme.
- [ ] Metrics include timeframe and comparison basis.
- [ ] The final recommendation has owner, next action, and timing.

## Print spot-check

Before finalizing, mentally preview the print flow:

- Cover/title block starts page 1.
- Executive summary does not split awkwardly.
- Tables do not lose headers or become too small to read.
- Appendix can start on a fresh page when the report is longer than 4 pages.
