# Readable Studio

**Turn source text into polished, standalone HTML - then edit it directly.**

Readable Studio is a Windows desktop document workspace for office workers. Bring in a brief, report, plan, meeting notes, or other company source material; use an AI coding agent to structure and design a first draft; then make ordinary revisions in the preview with PowerPoint-like direct editing. You do not have to send another prompt and wait whenever a heading, paragraph, position, size, or style needs a small change.

```text
source text -> AI generation -> PowerPoint-like direct editing -> standalone HTML
```

The result is an AI-readable company document and a self-contained HTML file that can be opened independently. This is Readable Studio's role in enterprise AI transformation: help company teams turn governed source material into documents that people can control directly and AI systems can continue to read. Readable Studio does not require a hosted page or publishing service.

## Who it is for

Readable Studio is designed for people who know the document they need but should not need to become frontend developers to produce it:

- operations, strategy, sales, finance, HR, and other office teams;
- subject-matter experts turning approved source material into a clear deliverable;
- teams standardizing recurring reports, briefs, presentations, and internal documents;
- developers and agents that need the same workflow through a CLI or HTTP API.

Source-grounded work is the default. The agent should preserve facts, terminology, and constraints from the supplied material instead of inventing a generic marketing page.

## The workflow

1. **Add source text.** Paste a brief or import a folder containing the material to use.
2. **Generate a first draft.** Choose a document or deck-oriented plugin, skill, and design system. Readable Studio dispatches the selected local agent and renders its files in the Studio.
3. **Edit directly.** Select an element in the preview. Change text, typography, spacing, geometry, colors, borders, and HTML without restarting generation.
4. **Use AI for substantive work.** Comments, prompts, critique, research, plugins, and automation remain available when a change benefits from an agent.
5. **Export standalone HTML.** Local static dependencies are inlined into one portable HTML file. PDF, PPTX for decks, ZIP, and Markdown remain available where the artifact supports them.

Direct editing complements the agent; it does not remove chat, CLI, plugins, skills, design systems, or export capabilities.

## Install on Windows

The supported product artifact is a **Windows 10/11 x64 portable ZIP**. There is no installer, updater, website download flow, macOS build, Linux build, or Nix product package.

1. Open [GitHub Releases](https://github.com/sanghyunna/readable-studio/releases) in a browser.
2. Manually download the latest `Readable Studio-<namespace>-portable.zip` asset.
3. Extract the complete ZIP to a writable folder.
4. Run `Readable Studio.exe` from the extracted folder.

Do not run the executable from inside the ZIP. Keep `ReadableStudioData` beside the executable when moving the extracted application; it contains namespace-scoped projects, settings, logs, cache, and Chromium profile data.

The destination computer does not need Node.js, pnpm, Git, an installer, or an updater.

## First document

1. Open Readable Studio and create a project.
2. Paste the source text and state the audience and purpose.
3. Select an available agent. Codex and Cursor Agent are scanned by default; additional installed adapters can be enabled in Settings.
4. Generate the draft.
5. Switch to **Edit**, select content in the preview, and revise it in place.
6. Choose **Export as standalone HTML**.

A useful first request is:

> Turn the attached quarterly review source into a concise executive document. Keep all figures and approved terminology, make decisions easy to scan, and prepare it for direct editing and standalone HTML export.

## Capabilities that remain integrated

### Direct editing

The editor bridges the rendered preview to source-backed changes. It includes text and typography controls, box-model and geometry controls, move/resize handles, shape controls, page/section controls, snap guides, attributes, selected-element HTML, and source editing. Comment and tweak modes remain available for agent-assisted refinement.

### Plugins, skills, and design systems

Plugins bind an end-to-end workflow to a run. A plugin is an Agent Skills-compatible folder with `SKILL.md` and, for full Readable Studio metadata, a `readable-studio.json` sidecar. Installed plugins can contribute inputs, capabilities, pipeline stages, examples, skills, and design-system references.

Use the Plugin page in the app or the same daemon APIs through the CLI:

```powershell
readable plugin list --json
readable plugin search "report" --json
readable plugin info <plugin-id> --json
readable plugin apply <plugin-id> --project <project-id> --input brief="..."
readable plugin validate .\my-plugin --json
```

See [`docs/plugins-spec.md`](docs/plugins-spec.md) and [`plugins/spec/SPEC.md`](plugins/spec/SPEC.md).

### CLI and automation

The `readable` CLI uses the same local daemon and `/api/*` contracts as the UI. Machine-consumed commands support `--json`; long prompts use `--prompt-file <path|->` where offered.

```powershell
readable project list --json
readable project create --name "Quarterly review" --json
readable files list --project <project-id> --json
readable export html --project <project-id> --file index.html --output .\quarterly-review.html --json
readable automation list --json
```

The CLI also exposes runs, conversations, artifacts, plugins, skills, design systems, research, memory, MCP, UI responses, and automation. Run `readable --help` for the installed command set.

### Export

Standalone HTML is the product's canonical handoff. It inlines statically discoverable local HTML, CSS, JavaScript modules, images, and fonts. External URLs and missing local references are preserved and reported rather than silently downloaded. Runtime network capture and multi-page crawling are outside this export contract.

Secondary artifact exports remain integrated:

| Artifact | Available exports |
| --- | --- |
| HTML document or prototype | standalone HTML, PDF, ZIP |
| Slide deck | standalone HTML, PDF, PPTX, ZIP |
| Markdown document | Markdown, HTML, PDF, ZIP |

## Data locations

| Mode | Location |
| --- | --- |
| Portable app | `<exeDir>\ReadableStudioData\namespaces\<namespace>\...` (daemon data is in `data\`) |
| Source checkout | `<repo>\.readable-studio\...` |
| Explicit override | absolute directory in `READABLE_DATA_DIR` |
| Development control-plane state | `<repo>\.tmp\tools-dev\<namespace>\...` |
| Portable build/control-plane state | `<repo>\.tmp\tools-pack\...` |

The daemon data root contains `app.sqlite`, `projects\`, `artifacts\`, installed user resources, and configuration. These are runtime files and should not be committed.

## Develop from source

Source development is for contributors, not the normal product download path. Use Windows, Node `~24`, and pnpm `10.33.2`:

```powershell
git clone https://github.com/sanghyunna/readable-studio.git
cd readable-studio
npm install -g pnpm@10.33.2
pnpm install
pnpm tools-dev
```

`pnpm tools-dev` is the only root development lifecycle command. There is no root `pnpm dev`, `pnpm start`, `pnpm build`, or `pnpm test` alias.

Build the supported portable artifact from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
```

The script selects Node 24, builds the workspace, creates `Readable Studio-<namespace>-portable.zip`, validates that artifact, and moves it to the requested drop directory.

### Windows portable lifecycle (maintainers)

```powershell
pnpm tools-pack win build
pnpm tools-pack win start
pnpm tools-pack win inspect --expr "document.title"
pnpm tools-pack win logs
pnpm tools-pack win stop
pnpm tools-pack win cleanup
```

These are local build and runtime controls, not release publishing automation.

## Architecture at a glance

```text
Windows desktop shell
        |
        v
Next.js web UI  <---- /api/* + SSE ---->  local daemon  ----> enabled agent CLI
     |                                      |                    (Codex/Cursor/etc.)
     |                                      +---- plugins / skills / design systems
     |                                      +---- .readable-studio data
     v
sandboxed preview + direct-edit bridge
     |
     +---- standalone HTML (canonical)
     +---- PDF / PPTX / ZIP / Markdown (artifact-dependent)
```

Read [`docs/architecture.md`](docs/architecture.md), [`docs/spec.md`](docs/spec.md), and [`QUICKSTART.md`](QUICKSTART.md) for the operating details.

## Contributing

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). English and Korean are the maintained product languages; translation policy is in [`TRANSLATIONS.md`](TRANSLATIONS.md). Repository history and third-party notices remain under their original names and wording.

## License

See [`LICENSE`](LICENSE).
