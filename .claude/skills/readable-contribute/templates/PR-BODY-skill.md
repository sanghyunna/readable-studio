## What this PR adds

A new Skill — **{{SKILL_NAME}}** — at `skills/{{SKILL_SLUG}}/`.

> {{PITCH}}

## Why I made it

{{MOTIVATION}}

## How to try it

1. `cd readable-studio`
2. Run Readable Studio locally: `pnpm tools-dev run web`
3. Open a project, start a chat, and ask: _"{{TRY_PROMPT}}"_

{{SCREENSHOT_BLOCK}}

## What's in this PR

- `skills/{{SKILL_SLUG}}/SKILL.md` — the skill itself (frontmatter + instructions)
- everything else inside `skills/{{SKILL_SLUG}}/` is referenced from `SKILL.md`

## Checklist

- [x] `SKILL.md` has a `name` and `description` in the frontmatter
- [x] Every relative path in `SKILL.md` resolves
- [x] No path escapes the skill folder
- [ ] Maintainer review

---

👋 This is my first Readable Studio contribution. Hi! If anything looks off, tell me what to change and I'll happily push a fixup commit.

If you want to chat (or you're another newcomer reading this and want help shipping your first PR), come hang out in the Readable Studio Discord: {{DISCORD_INVITE}}

_Generated with the `readable-contribute` skill._
