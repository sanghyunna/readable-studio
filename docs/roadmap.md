# Readable Studio roadmap

## Product direction

Readable Studio is a Windows document workspace for office workers:

```text
source text -> AI generation -> PowerPoint-like direct editing -> standalone HTML
```

The roadmap optimizes that complete loop. It does not optimize for more prompt turns, a hosted publishing destination, or additional operating-system packages.

## Current baseline

- Windows 10/11 x64 portable ZIP is the only supported artifact.
- Users manually download it from GitHub Releases, extract it, and run `Readable Studio.exe`.
- The local desktop shell, web UI, daemon, enabled agent adapters, CLI, plugins, skills, design systems, preview, direct editing, and export pipeline operate as one product.
- Standalone HTML is canonical; PDF, PPTX, ZIP, and Markdown remain artifact-dependent secondary outputs.
- Source-mode data defaults to `.readable-studio`; portable data stays beside the executable under `ReadableStudioData\namespaces\<namespace>`.

## Active priorities

1. **Source fidelity** - make imported business material, terminology, tables, and constraints easy to carry into a draft and audit afterward.
2. **Office-worker editing** - deepen reliable text, typography, layout, geometry, page, and style controls without requiring HTML knowledge.
3. **Fast handoff between AI and direct manipulation** - reserve agent runs for substantive work and make mechanical corrections immediate.
4. **Standalone HTML quality** - improve deterministic inlining, warnings, accessibility, portability, and document structure.
5. **Company document workflows** - strengthen reports, briefs, plans, decks, recurring templates, and review flows.
6. **Integrated extensibility** - keep plugins, skills, design systems, CLI, HTTP APIs, and automation aligned with the same workflow.
7. **Windows portable reliability** - keep build, extraction, startup, data portability, diagnostics, and local lifecycle reproducible.

## Delivery principles

- UI and CLI capabilities land together against shared `/api/*` contracts.
- Product language is maintained in English and Korean.
- Portable builds remain local tooling; release assets are downloaded manually from GitHub Releases.
- Changes are measured against capability parity so narrowing distribution never removes editing, plugin, CLI, or export behavior accidentally.
- History, upstream citations, provenance, and legal text remain truthful rather than being rewritten to match current positioning.

## Non-goals

- no product website or hosted document destination;
- no automatic updater, installer, app store, or release-publishing automation;
- no macOS, Linux, WSL, or Nix product distributions;
- a prompt-only workflow for minor edits;
- replacing the integrated CLI/plugin surface with a desktop-only interface;
- claiming that standalone export captures runtime network traffic or arbitrary multi-page applications.
