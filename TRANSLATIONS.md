# Readable Studio translation guide

Readable Studio maintains two product languages:

| Locale | Language | UI dictionary | Maintained core docs |
| --- | --- | --- | --- |
| `en` | English | `apps/web/src/i18n/locales/en.ts` | root documentation |
| `ko` | Korean | `apps/web/src/i18n/locales/ko.ts` | `docs/i18n/*.ko.md` where present |

Other translated documents may remain as historical community material. Their presence does not mean the current UI or Windows portable product supports that locale. Do not delete or bulk-rewrite those files as part of an unrelated locale change.

## Product language to preserve

Translations should retain the approved workflow and audience:

```text
Source Text -> AI Generation -> Direct Editing -> Standalone HTML
```

- Readable Studio is for office workers producing AI-readable company documents.
- The first draft is grounded in supplied source material.
- PowerPoint-like direct editing avoids another prompt-and-wait cycle for small revisions.
- Standalone HTML is the canonical output.
- Plugins, skills, design systems, CLI access, comments, tweaks, automation, and artifact-dependent PDF/PPTX/ZIP/Markdown exports remain integrated.
- The product artifact is a manually downloaded Windows 10/11 x64 portable ZIP from GitHub Releases.

Do not introduce claims for a website, installer, updater, macOS build, Linux build, Nix package, or automatic publishing.

## Add or change a UI string

1. Add the key to `apps/web/src/i18n/types.ts`.
2. Add English copy to `apps/web/src/i18n/locales/en.ts`.
3. Add Korean copy to `apps/web/src/i18n/locales/ko.ts`.
4. Preserve placeholders exactly, including names and brace syntax.
5. Run the web typecheck and i18n tests.

```powershell
pnpm --filter @readable-studio/web typecheck
pnpm --filter @readable-studio/web test
pnpm i18n:check
```

Do not add an untyped locale file or widen `Locale` without an explicit product decision covering the complete UI and maintenance cost.

## Translate documentation

Translate meaning and operating facts, not just words.

Keep these machine-consumed values unchanged:

- commands and flags such as `readable export html --json`;
- environment variables such as `READABLE_DATA_DIR`;
- file names such as `SKILL.md`, `DESIGN.md`, and `readable-studio.json`;
- paths such as `.readable-studio`, `ReadableStudioData`, and `.tmp`;
- JSON keys, API routes, locale codes, plugin IDs, and code symbols;
- URLs and Markdown link targets unless the target has an intentional localized counterpart.

Code blocks may translate comments, but never alter the executable command to make it read naturally.

## Korean terminology

Use one term consistently within a page. Preferred choices:

| English | Korean guidance |
| --- | --- |
| Readable Studio | `Readable Studio` |
| source text | `원문` or `소스 텍스트` according to surrounding business context |
| AI generation | `AI 생성` |
| direct editing | `직접 편집` |
| standalone HTML | `독립 실행형 HTML` |
| office worker | `사무직 사용자` |
| plugin | `플러그인` |
| skill | `스킬` |
| design system | `디자인 시스템` |
| portable ZIP | `포터블 ZIP` |

Keep brand names, agent names, and protocol names in their official spelling.

## Review checklist

- [ ] The English and Korean dictionaries have the same typed keys.
- [ ] Placeholders match exactly.
- [ ] The source-to-HTML workflow and office-worker audience remain explicit.
- [ ] Direct editing is not described as prompt-only iteration.
- [ ] Windows portable download and data paths are accurate.
- [ ] Commands, file names, plugin IDs, and API routes are unchanged.
- [ ] Links resolve from the translated file's directory.
- [ ] Agent-executed prompts and workflow source were not translated accidentally.
- [ ] `pnpm i18n:check`, relevant web tests, `pnpm guard`, and `pnpm typecheck` pass.

## What not to translate

Do not translate:

- changelog history or release notes solely to synchronize current marketing language;
- `specs/change/` records;
- upstream issue quotations or citation titles;
- license, notice, copyright, or third-party attribution text without legal review;
- prompt and skill bodies merely because their display metadata is localized.

These surfaces preserve history, provenance, legal meaning, or machine behavior.
