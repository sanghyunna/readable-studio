# Readable Studio architecture

This document describes the current product topology and data flow. Product intent is in [`spec.md`](spec.md); contributor boundaries are in [`../AGENTS.md`](../AGENTS.md).

## End-to-end flow

```text
business source material
          |
          v
   project files + context
          |
          v
 plugin / skill / design system -----> enabled coding-agent CLI
          |                                      |
          +-------------- local daemon <---------+
                              |
                       /api/* and SSE
                              |
                    Next.js Studio UI
                              |
            sandboxed preview + edit bridge
                              |
          source-backed direct edits and comments
                              |
          standalone HTML / PDF / PPTX / ZIP / MD
```

The architectural objective is a quick handoff from agent generation to direct manipulation. A small correction should flow through the edit bridge and persistence API, not require another prompt. Substantive work can return to the agent with the updated source as context.

## Runtime topology

### Portable product

The Windows portable ZIP contains `Readable Studio.exe` and bundled runtime resources. The Electron shell starts namespace-scoped daemon and web sidecars, discovers their status through sidecar IPC, and opens the local UI. Ports are transient transport details; they never determine data, log, cache, or runtime paths.

```text
<exeDir>\
├── Readable Studio.exe
└── ReadableStudioData\
    └── namespaces\<namespace>\
        ├── data\
        │   ├── app.sqlite
        │   ├── projects\
        │   └── artifacts\
        ├── logs\
        ├── cache\
        ├── runtime\
        └── user-data\
```

The package is portable: no installer, updater, or destination-machine development toolchain is involved.

### Source development

`pnpm tools-dev` owns daemon, web, and desktop lifecycle. Source daemon data defaults to `<repo>\.readable-studio`; control-plane runtime state is separate under `<repo>\.tmp\tools-dev\<namespace>`. `READABLE_DATA_DIR` relocates daemon data when set to an accepted path.

## Components

### Web UI (`apps/web`)

The Next.js App Router application owns projects, conversation, source-file navigation, plugin selection, settings, preview, direct editing, and export actions. HTML renders in a sandboxed iframe. Features that need bridges use the `srcDoc` path so the host can inject selection, edit, comment, deck, palette, and tweak communication.

### Daemon (`apps/daemon`)

The local daemon is the authority for `/api/*` contracts and persistence. It owns projects, conversations, runs, agent spawning, plugins, skills, design systems, artifact files, import/export, research, memory, automation, and static resource serving. UI and CLI call the same endpoints.

### Agent adapters

Adapters detect and invoke installed coding-agent CLIs through controlled argument builders. Codex and Cursor Agent are enabled for scanning by default; users can enable other registered adapters. Runs execute with project context, plugin/skill instructions, design-system context, and source files.

### CLI (`readable`)

The CLI is the machine and external-agent surface. It mirrors daemon capabilities and supports JSON output. It includes projects, runs, conversations, files, artifacts, standalone HTML export, plugins, skills, design systems, research, memory, MCP, UI responses, and automation.

### Plugins and resources

A plugin folder has `SKILL.md` and may have `readable-studio.json`. The plugin runtime resolves manifests, capabilities, inputs, snapshots, stages, and bundled references. Skills and design systems remain file-based so they are inspectable, versionable, and portable.

### Contracts and sidecars

`packages/contracts` contains pure shared DTOs and prompt contracts. `packages/sidecar-proto` owns Readable Studio process and IPC semantics, `packages/sidecar` owns generic sidecar runtime primitives, and `packages/platform` owns generic OS process operations.

## Document and edit data flow

1. The user creates or imports a project.
2. Source text and files are stored in the project directory.
3. The UI applies a plugin or selects defaults and starts a run through the daemon.
4. The daemon composes project source, plugin/skill instructions, design system, and conversation context.
5. The adapter starts the enabled agent CLI and streams events through SSE.
6. Generated files are written to the project and rendered in the preview.
7. Edit mode selects an element through the iframe bridge.
8. Direct-edit controls produce a validated source patch and persist it through the daemon.
9. Export resolves the current source, inlines local dependencies for standalone HTML, and reports unresolved references.

## Storage

The daemon data root contains:

```text
<dataRoot>\
├── app.sqlite
├── projects\<project-id>\
├── artifacts\
├── skills\
├── design-systems\
├── plugins\
└── media-config.json
```

Imported-folder projects may point to an approved absolute source directory instead of `projects\<id>`. Project listing and mutation stay behind daemon validation. Runtime data is gitignored.

## Export architecture

Standalone HTML export has UI, CLI, and HTTP entry points. It resolves an HTML source from a project, plugin example, design-system preview, inline input, or standard input. The bundler recursively inlines statically discoverable local dependencies and applies size and path limits. It does not fetch external assets.

Artifact manifests control secondary exports:

- HTML: standalone HTML, PDF, ZIP;
- deck: standalone HTML, PDF, PPTX, ZIP;
- Markdown: Markdown, HTML, PDF, ZIP.

## Packaging controls

The project-root `build-portable.ps1` is the canonical Windows workspace build. The lower-level local lifecycle is:

```powershell
pnpm tools-pack win build
pnpm tools-pack win start
pnpm tools-pack win inspect --expr "document.title"
pnpm tools-pack win logs
pnpm tools-pack win stop
pnpm tools-pack win cleanup
```

Build artifacts are under `.tmp\tools-pack\out\win\namespaces\<namespace>` and packaged runtime state under `.tmp\tools-pack\runtime\win\namespaces\<namespace>`. No command in this repository publishes a release.

## Security boundaries

- privileged filesystem and process work stays in the daemon;
- user paths are normalized and constrained before access;
- preview content is sandboxed;
- plugin capabilities are explicit and minimized;
- command structure is adapter-controlled, while user content enters prompts or files;
- secrets and runtime data are not committed;
- standalone export never silently downloads remote dependencies.

## Platform boundary

The product supports Windows 10/11 x64 portable ZIP only. Architecture may retain generic internals where they simplify ownership, but those internals are not product claims for other operating systems or package formats.
