# Windows troubleshooting

Readable Studio supports Windows 10/11 x64. Normal users should run the extracted portable ZIP; contributors can run the source workspace with Node 24.

## Portable app

### Download and extraction

Manually download `Readable Studio-<namespace>-portable.zip` from [GitHub Releases](https://github.com/sanghyunna/readable-studio/releases), extract the complete archive to a writable directory, and run `Readable Studio.exe`. Do not run it from the compressed-folder view.

### SmartScreen warning

An unsigned build can trigger Windows SmartScreen. Confirm that the archive came from the repository's GitHub Releases page and verify the release asset before running it. Readable Studio has no installer or updater.

### Projects disappeared after moving the app

Portable state lives beside the executable under:

```text
<exeDir>\ReadableStudioData\namespaces\<namespace>\
```

Move or back up `ReadableStudioData` together with `Readable Studio.exe`. Different namespaces intentionally use separate state.

### App does not start

- Extract all files rather than copying only the executable.
- Use a writable local directory.
- Check logs with the local packaging lifecycle if this is a maintainer build:

```powershell
pnpm tools-pack win logs
pnpm tools-pack win inspect --expr "document.title"
```

## Source development

### Wrong Node version

Readable Studio requires Node `~24`.

```powershell
node --version
```

Install Node 24 from [nodejs.org](https://nodejs.org/) or with WinGet, then open a new terminal. Node 22 is not supported by this workspace.

### pnpm or Corepack permission error

`corepack enable` can fail because it tries to write shims under Program Files. Install the pinned pnpm version directly:

```powershell
npm install -g pnpm@10.33.2
pnpm --version
```

### `better-sqlite3` build fails

Node 24 uses a local native build. Install Python 3 and Visual Studio Build Tools 2022 or newer with the Desktop development with C++ workload, then run:

```powershell
pnpm install
pnpm --filter @readable-studio/daemon exec node -e "require('better-sqlite3')"
```

### Agent is not detected

Codex and Cursor Agent are scanned by default. Confirm the CLI works and is authenticated in the same Windows user environment that starts Readable Studio:

```powershell
codex --version
cursor-agent --version
```

Then use Rescan in Settings. Enable another registered adapter before expecting Readable Studio to probe it.

### Port or stale process problem

Use the control plane rather than starting packages independently:

```powershell
pnpm tools-dev status --json
pnpm tools-dev logs --json
pnpm tools-dev stop
pnpm tools-dev check
```

### Data directory

Source data defaults to `<repo>\.readable-studio`. `READABLE_DATA_DIR` may point to an explicit absolute directory. Development lifecycle state is separate under `<repo>\.tmp\tools-dev\<namespace>`.

## Portable build diagnosis

The canonical workspace build is:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
```

The complete lower-level lifecycle is:

```powershell
pnpm tools-pack win build
pnpm tools-pack win start
pnpm tools-pack win inspect --expr "document.title"
pnpm tools-pack win logs
pnpm tools-pack win stop
pnpm tools-pack win cleanup
```

Build output is namespace-scoped under `.tmp\tools-pack\out\win\namespaces\<namespace>` and runtime state under `.tmp\tools-pack\runtime\win\namespaces\<namespace>`.
