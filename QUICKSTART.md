# Readable Studio quickstart

This guide covers the supported Windows portable app and contributor development.

## Use the portable app

### Requirements

- Windows 10 or Windows 11, x64
- permission to extract a ZIP and run an executable from a writable folder
- an installed and authenticated coding-agent CLI for local-agent mode; Codex and Cursor Agent are scanned by default

The portable app itself does not require Node.js, pnpm, Git, an installer, or an updater on the destination computer.

### Download and start

1. Open [GitHub Releases](https://github.com/sanghyunna/readable-studio/releases).
2. Manually download `Readable Studio-<namespace>-portable.zip` from the release assets.
3. Extract the entire archive, for example to `C:\Tools\Readable Studio`.
4. Run `Readable Studio.exe` from the extracted directory.

Do not launch the executable inside the compressed-folder view. Windows may show a SmartScreen warning for an unsigned build; verify that the file came from the repository's GitHub Releases page before choosing to run it.

### Create a document

1. Create a project and name the intended deliverable.
2. Paste source text or import a folder containing the approved material.
3. Choose a plugin, skill, and design system if the defaults do not fit.
4. Ask for a source-grounded first draft. Include audience, purpose, and constraints.
5. When generation finishes, open **Edit** and select an element in the preview.
6. Make text, typography, spacing, position, size, color, border, or HTML changes directly.
7. Export **standalone HTML** when the document is ready.

Suggested request:

```text
Turn this source into a concise quarterly operating review for department leads.
Preserve all figures and approved terms. Use clear sections and scannable tables.
Prepare the result for direct editing and standalone HTML export.
```

Use comments or another prompt for a substantive rewrite. Use direct editing for small visual and content corrections so you do not wait on unnecessary regeneration.

## Where portable data lives

The portable app writes beside the executable:

```text
<extracted folder>\
├── Readable Studio.exe
└── ReadableStudioData\
    └── namespaces\
        └── <namespace>\
            ├── data\
            │   ├── app.sqlite
            │   ├── projects\
            │   └── artifacts\
            ├── logs\
            ├── cache\
            ├── runtime\
            └── user-data\
```

Keep `ReadableStudioData` with the application when moving it. Back up that directory before deleting or replacing an extracted copy. An absolute `READABLE_DATA_DIR` can override the data root for controlled deployments.

## Export behavior

Standalone HTML is the canonical output. Readable Studio inlines statically discoverable local HTML, CSS, JavaScript module, image, and font dependencies. External HTTP(S) URLs and missing local references remain in place and are reported as warnings; the exporter does not crawl websites or capture runtime network traffic.

The UI also retains PDF and ZIP exports, PPTX for decks, and Markdown where supported by the artifact manifest.

The CLI equivalent is:

```powershell
readable export html --project <project-id> --file index.html --output .\document.html --json
```

## Develop from source

### Requirements

- Windows 10/11 x64
- Node `~24`
- pnpm `10.33.2`
- Visual Studio Build Tools 2022 or newer and Python 3 for the native `better-sqlite3` build
- an authenticated agent CLI, or configured API mode

On Windows, install pnpm directly because `corepack enable` commonly fails when it tries to write shims under Program Files:

```powershell
npm install -g pnpm@10.33.2
node --version
pnpm --version
```

### Start the development workspace

```powershell
git clone https://github.com/sanghyunna/readable-studio.git
cd readable-studio
pnpm install
pnpm tools-dev
```

`pnpm tools-dev` is the only root lifecycle entry point. Useful controls:

```powershell
pnpm tools-dev status --json
pnpm tools-dev logs --json
pnpm tools-dev inspect desktop status --json
pnpm tools-dev stop
pnpm tools-dev check
```

Source-mode daemon data defaults to:

```text
<repo>\.readable-studio\
├── app.sqlite
├── projects\<id>\
├── artifacts\
├── skills\
├── design-systems\
└── media-config.json
```

Development control-plane state is separate under `.tmp\tools-dev\<namespace>\...`. Set `READABLE_DATA_DIR` to an absolute path to relocate daemon data.

## Build the Windows portable ZIP

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
```

Optional parameters include `-Namespace`, `-DropDir`, `-PortableZipCompression 0..9`, and `-AppVersion`. The script requires Node 24, builds the workspace, produces `Readable Studio-<namespace>-portable.zip`, verifies that the expected file exists, and moves it to the drop directory.

For local packaging diagnosis, these are the complete six-command Windows lifecycle:

```powershell
pnpm tools-pack win build
pnpm tools-pack win start
pnpm tools-pack win inspect --expr "document.title"
pnpm tools-pack win logs
pnpm tools-pack win stop
pnpm tools-pack win cleanup
```

Build output is under `.tmp\tools-pack\out\win\namespaces\<namespace>\`; runtime state is under `.tmp\tools-pack\runtime\win\namespaces\<namespace>\`. These commands build and inspect locally. They do not publish a release.

## Plugin and CLI checks

A plugin minimally contains `SKILL.md`; add `readable-studio.json` for typed metadata and integrated catalog behavior:

```text
my-plugin\
├── SKILL.md
└── readable-studio.json
```

```powershell
readable plugin validate .\my-plugin --json
readable plugin install .\my-plugin --json
readable plugin list --json
readable project list --json
```

The UI and CLI use the same daemon API. Prefer `--json` for scripts and `--prompt-file <path|->` for long prompts on commands that accept prompts.

## Troubleshooting

- **No agent is available:** authenticate Codex or Cursor Agent in the same Windows user environment, then rescan. Enable other installed adapters explicitly in Settings.
- **The app loses projects after being moved:** move `ReadableStudioData` with `Readable Studio.exe`.
- **The app was run from inside the ZIP:** extract all files and run the extracted executable.
- **Native module ABI error in source mode:** activate Node 24, run `pnpm install`, then verify with `pnpm --filter @readable-studio/daemon exec node -e "require('better-sqlite3')"`.
- **The artifact renders but standalone export warns:** inspect the reported external or missing references. Add local assets when the final document must be entirely self-contained.

More Windows setup detail is in [`docs/windows-troubleshooting.md`](docs/windows-troubleshooting.md).
