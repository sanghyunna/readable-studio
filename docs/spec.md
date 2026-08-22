# Readable Studio product specification

## Product statement

Readable Studio turns source text into polished standalone HTML through AI generation and PowerPoint-like direct editing. It is designed for office workers creating AI-readable company documents without waiting for an agent to regenerate every minor revision. In enterprise AI transformation, it keeps governed company source, human editorial control, and AI-readable document structure in one inspectable workflow.

```text
Source Text -> AI Generation -> Direct Editing -> Standalone HTML
```

## Target users

- office teams producing reports, briefs, plans, presentations, and recurring internal documents;
- subject-matter experts who own content accuracy but do not want to edit frontend code;
- company teams applying shared design systems and approved source material;
- developers and external agents using the same local capabilities through the CLI and HTTP API.

## Core requirements

### Source-grounded generation

A project accepts pasted text and imported files. Agent prompts include the selected source, plugin/skill instructions, design system, and project context. Generated artifacts should preserve supplied facts and terminology. The product must not present an empty prompt as the only normal starting point.

### Direct editing

The rendered preview supports source-backed element selection and direct changes to content and presentation. Required control families include text, typography, box model, geometry, move, resize, shape, page/section, snap guides, attributes, selected-element HTML, and source editing. Direct edits persist to project files and coexist with comments, tweaks, and agent revisions.

### Standalone HTML

The canonical handoff is one HTML file. Export inlines statically discoverable local HTML, CSS, JavaScript modules, images, and fonts. External HTTP(S) references and missing local references are preserved and reported. Runtime network capture, service-worker capture, and multi-page crawling are outside the contract.

### Integrated extension and automation surfaces

Plugins, skills, design systems, templates, CLI commands, MCP tools, HTTP APIs, research, memory, and automation remain available. A plugin uses `SKILL.md` and may add `readable-studio.json` metadata. User-facing capabilities use the same daemon endpoints from the web UI and `readable` CLI.

### Secondary exports

Artifact manifests may expose PDF, PPTX, ZIP, and Markdown. These formats remain supported where implemented, but they do not replace standalone HTML as the canonical product thesis.

## Runtime shape

```text
Readable Studio.exe
  -> packaged Electron shell
      -> local daemon
      -> local Next.js web runtime
          -> sandboxed preview + direct-edit bridge
      -> enabled coding-agent CLI
      -> local plugins / skills / design systems / data
```

Source development uses the same web and daemon services under `pnpm tools-dev`.

## Distribution

The supported artifact is a Windows 10/11 x64 portable ZIP downloaded manually from GitHub Releases. Users extract the archive and run `Readable Studio.exe`. The destination computer does not need Node.js, pnpm, Git, an installer, or an updater.

Portable data lives under `<exeDir>\ReadableStudioData\namespaces\<namespace>`. Source-mode daemon data defaults to `<repo>\.readable-studio`. `READABLE_DATA_DIR` accepts an absolute override.

There is no product website, installer, updater, macOS package, Linux package, Nix package, or release-publishing workflow.

## Success criteria

- An office worker can start with supplied source, generate a structured draft, correct it directly, and export standalone HTML without editing code.
- Minor text and layout corrections do not require another agent round trip.
- The HTML output remains structured and usable by people and downstream tools.
- UI and CLI expose the same product capabilities through shared contracts.
- Plugin and design-system workflows remain portable and inspectable as files.
- A clean Windows 10/11 x64 machine can run the extracted portable archive without a development toolchain.

## Non-goals

- automatic publication or hosted share URLs;
- replacing professional vector illustration or slide authoring for every use case;
- hiding source files behind an opaque canvas format;
- treating AI output as authoritative when it conflicts with supplied company source;
- supporting additional operating-system artifacts without a separate product decision.
