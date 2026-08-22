# Contributing to Readable Studio

Readable Studio turns source text into standalone HTML with AI generation and PowerPoint-like direct editing for office workers. Contributions should strengthen that workflow without removing the integrated UI, CLI, plugin, editing, or export paths.

Read [`AGENTS.md`](AGENTS.md) first, then the nearest directory-level `AGENTS.md` before editing code in that area.

## Product relevance

A contribution is in scope when it improves a shipped capability or its maintainability, including:

- source-grounded document or deck generation;
- direct editing, preview, comments, tweaks, and source persistence;
- standalone HTML and artifact-dependent PDF/PPTX/ZIP/Markdown export;
- plugins, skills, design systems, templates, and craft guidance;
- the `readable` CLI and the shared daemon HTTP contracts;
- Windows portable packaging and local development tooling;
- English or Korean product language.

Do not add product claims or implementation for a website, updater, installer, macOS package, Linux package, or Nix package. The supported artifact is a manually downloaded Windows 10/11 x64 portable ZIP.

## Set up on Windows

Required: Node `~24`, pnpm `10.33.2`, Python 3, and Visual Studio Build Tools 2022 or newer.

```powershell
git clone https://github.com/sanghyunna/readable-studio.git
cd readable-studio
npm install -g pnpm@10.33.2
pnpm install
pnpm tools-dev
```

`better-sqlite3` compiles from source for Node 24 on Windows. This is expected. Use `pnpm tools-dev` for the development lifecycle; do not add root `dev`, `start`, `build`, or `test` aliases.

## Make a focused change

- Open an issue before a non-trivial feature.
- Keep one pull request focused on one user or maintenance outcome.
- Put package tests in the package-level `tests/` directory, not under `src/`.
- Keep shared UI/daemon DTOs in `packages/contracts`.
- Every user-facing capability must remain reachable through both the web UI and the `readable` CLI unless the PR explains why a surface is not applicable.
- CLI machine output uses `--json`; long prompts use `--prompt-file <path|->` where relevant.
- Do not hand-build process stamps, namespace paths, or packaged launch arguments outside their owning packages.

## Document workflow behavior accurately

Use the canonical terms in [`CONTEXT.md`](CONTEXT.md). In current product docs:

- lead with `Source Text -> AI Generation -> Direct Editing -> Standalone HTML`;
- describe direct editing as avoiding unnecessary prompt-wait cycles, not replacing agents;
- preserve plugin, CLI, and secondary export capabilities;
- use `.readable-studio` for source-mode daemon data;
- use `ReadableStudioData\namespaces\<namespace>` for portable data;
- name plugin sidecars `readable-studio.json`;
- point downloads only to manual GitHub Releases;
- do not rewrite changelog entries, `specs/change/`, upstream issue citations, provenance, or legal text.

Pure prose does not need a test that pins its wording. Validate links, references, and commands instead.

## Add a plugin

A plugin is a portable Agent Skills folder:

```text
my-plugin\
├── SKILL.md
└── readable-studio.json
```

`SKILL.md` contains agent-readable workflow instructions. `readable-studio.json` is the optional typed sidecar for identity, version, inputs, capabilities, pipeline stages, examples, and resource references. Do not duplicate the skill body in the JSON.

```powershell
readable plugin validate .\my-plugin --json
pnpm guard
pnpm --filter @readable-studio/plugin-runtime typecheck
```

Follow [`plugins/AGENTS.md`](plugins/AGENTS.md), [`plugins/spec/SPEC.md`](plugins/spec/SPEC.md), and [`plugins/spec/CONTRIBUTING.md`](plugins/spec/CONTRIBUTING.md).

## Add a skill or design system

Skills live in `skills/<id>/SKILL.md` and follow the repository's Agent Skills protocol. Read [`skills/AGENTS.md`](skills/AGENTS.md) and [`docs/skills-contributing.md`](docs/skills-contributing.md).

Design systems live in `design-systems/<id>/` and must satisfy the schema and evidence requirements described by [`design-systems/_schema/AGENTS.md`](design-systems/_schema/AGENTS.md). They should be reusable brand contracts, not one-off artifact prompts.

## Add or change a CLI capability

The daemon HTTP endpoint is the source of truth. Add or update:

1. a DTO in `packages/contracts`;
2. the daemon `/api/*` endpoint;
3. the web UI surface;
4. the `readable` subcommand registered through `SUBCOMMAND_MAP`;
5. focused tests for both human and `--json` behavior.

Do not create a CLI-only product feature.

## Localization

English (`en`) and Korean (`ko`) are the maintained product locales. Add keys to the typed dictionary and both locale files in the same change. Agent-executed prompts, skill instructions, design-system source, commands, identifiers, file names, and JSON keys stay in their source language unless the relevant protocol explicitly localizes them.

See [`TRANSLATIONS.md`](TRANSLATIONS.md).

## Verification

Run checks matching the changed area, then the repository baseline:

```powershell
pnpm guard
pnpm typecheck
```

Examples:

```powershell
pnpm --filter @readable-studio/contracts typecheck
pnpm --filter @readable-studio/web test
pnpm --filter @readable-studio/daemon test
pnpm --filter @readable-studio/tools-pack test
```

For a requested Windows workspace build, use the canonical entry point:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
```

Package-scoped builds are validation, not a substitute for that portable build.

## Pull requests

Use [`.github/pull_request_template.md`](.github/pull_request_template.md). Explain the user's problem, what users will see, every affected surface, and the exact verification performed. Attach entry-point screenshots for UI changes. Bug fixes should include a focused regression test that fails before the fix when practical.

Commit messages should be imperative and scoped. Do not add co-author trailers. Never commit `.readable-studio/`, `.tmp/`, generated reports, credentials, or portable runtime data.

## License

By contributing, you agree that your contribution is licensed under the repository's [`LICENSE`](LICENSE).
