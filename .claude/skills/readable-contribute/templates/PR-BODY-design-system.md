## What this PR adds

A new Design System — **{{BRAND_NAME}}** — at `design-systems/{{BRAND_SLUG}}/DESIGN.md`.

> {{PITCH}}

## What this design system covers

{{COVERAGE_NOTES}}

## How to try it

1. `cd readable-studio`
2. `pnpm tools-dev run web`
3. Start a new project and pick **{{BRAND_NAME}}** from the design system picker.
4. Ask the model: _"{{TRY_PROMPT}}"_

{{SCREENSHOT_BLOCK}}

## What's in this PR

- `design-systems/{{BRAND_SLUG}}/DESIGN.md` — the canonical design brief Readable Studio loads.
- Any supporting assets in `design-systems/{{BRAND_SLUG}}/` are referenced from `DESIGN.md`.

## Checklist

- [x] DESIGN.md has the conventional sections (compared against existing Readable Studio design systems)
- [x] No `../` path escapes outside the brand folder
- [ ] Maintainer review

---

👋 This is my first Readable Studio contribution. Hi! If anything looks off, tell me what to change and I'll happily push a fixup commit.

If you want to chat (or you're another newcomer reading this and want help shipping your first PR), come hang out in the Readable Studio Discord: {{DISCORD_INVITE}}

_Generated with the `readable-contribute` skill._
