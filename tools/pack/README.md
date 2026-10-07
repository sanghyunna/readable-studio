# tools/pack

Local Windows portable packaging control plane for Readable Studio.

## Commands

- `tools-pack win build`
- `tools-pack win start`
- `tools-pack win inspect --expr "document.title"`
- `tools-pack win logs`
- `tools-pack win stop`
- `tools-pack win cleanup`

Build artifacts are namespace-scoped under
`.tmp/tools-pack/out/win/namespaces/<namespace>/`. Packaged runtime state is
namespace-scoped under
`.tmp/tools-pack/runtime/win/namespaces/<namespace>/`.

The ZIP is named `Readable-Studio-win-x64-portable.zip` in every namespace and
release. It has no enclosing folder; extract it into a writable folder such as
`Readable Studio` on Windows and run `Readable Studio.exe` directly. The GitHub
release tag carries the version and the release asset body carries the SHA-256;
the stable filename does not replace packaged version metadata.
The build always produces that portable artifact; tools-pack has no installer,
updater, alternate target, or compatibility mode.

Windows portable archives retain the shared bundled resource trees and generic
sidecar/platform runtime primitives used by the packaged application.

## Faster release builds

The root release entrypoint enables FastBuild by default. Direct tools-pack
invocations still opt in explicitly:

```powershell
.\build-portable.ps1
# Controlled legacy-path comparison, without changing compression:
.\build-portable.ps1 -FastBuild:$false
# Or, after building tools-pack itself:
pnpm tools-pack win build --fast-build
```

The flag overlaps resource/icon preparation with tarball/app preparation after
workspace compilation. ZIP compression remains level 5, with at most 20
available CPU threads. Level 1 requires an explicit `-PortableZipCompression 1`
or `READABLE_PORTABLE_ZIP_COMPRESSION=1` and may produce a larger download.
File selection, metadata policy, signing, and runtime checks are unchanged. ZIP cache keys include the thread
setting, so fast archives cannot replace ordinary cached ZIPs. The first default
release build therefore misses the old ZIP cache. Without the flag, preparation
remains serial and ZIP thread arguments stay automatic. Fast builds also request
7-Zip execution statistics (`-bt`); ZIP segment details expose CPU seconds, wall
seconds and average busy cores when those statistics are available.

Workspace builds use dependency-keyed package caches under
`cache/workspace-packages/`, independent of FastBuild. Unchanged packages retain
validated outputs; deleted required outputs restore from cache. Unchanged web
inputs and shared dependencies reuse the exact Next output rather than rebuilding
its BUILD_ID. Package source, dependency keys, root manifest/lock/patches,
toolchain environment and web build environment participate in invalidation.
Ready packages run concurrently, bounded by available processors and 20 slots;
the workspace mutation lock still serializes separate builds sharing this cache.
Successful snapshots are not copied back over freshly built outputs, and there
is no second aggregate workspace snapshot. First use fills the new package caches;
whole-build content equivalence and speedup are not yet qualified.

Whole-build speedup and real-archive equivalence still require an approved measurement
window. Do not run a performance build alongside a release build. The first-pass
analysis and validation record are in `.omo/evidence/build-perf/report.md`.

## Opt-in build profiling (exclusive measurement window required)

`build-portable.ps1 -ProfileBuild` records a nominal one-second Windows utilization
time series under `.omo/evidence/build-perf/utilization-<run-id>.log`: normalized
system/build-tree CPU, physical-disk bytes/sec, IOPS, queue depth, process/child
counts, top CPU consumers, and recorder overhead. The recorder confirms readiness
before any build command. It is stopped in `finally`; only its own PID can be killed.
Profiling does not change the selected FastBuild setting. The final comparison ZIP keeps the canonical
`Readable-Studio-win-x64-portable.zip` filename. Use a separate `-DropDir` for each
comparison run; an existing comparison file is never replaced.
Published 1.1.5 and hotfix ZIPs must never be used as output destinations.
`-CacheDir` forwards the existing tools-pack cache option. After explicit measurement
clearance, use a new private cache for a full cache-miss trace without deleting the
release cache; keep namespace/version/source inputs fixed across comparison runs.

Profiling also sets `READABLE_TOOLS_PACK_PROFILE=1`. That environment variable alone
enables detailed timing without starting the utilization recorder. Existing phase
markers gain epoch-millisecond timestamps; `[tools-pack profile]` JSON records cover
cache key inputs, global-lock wait, alias seeding, snapshots/materialization, the
recursive workspace build, native/web-sidecar tail, sourcemaps, individual prebundles,
npm installation, and after-pack copies/pruning/audits. Recursive pnpm lifecycle
records preserve their original child timestamps. Timings are inclusive; do not sum
parent and child durations. The original after-pack hook and its cache hash remain
unchanged; profiling loads a separate generated wrapper around that same hook.

Collection has measurable observer overhead, reported in each sample. Missing/new
process CPU observations are null with an explicit coverage count, never fabricated
zeroes. Short-lived processes between samples may be missed; phase and pnpm lifecycle
timestamps remain available. These records diagnose idle time; they do not prove an
antivirus or lock cause without the corresponding evidence. No profiler runs on the
ordinary build path.
