# tools/pack

Follow the root `AGENTS.md` and `tools/AGENTS.md` first. This tool owns the repo-external packaged build/start/stop/logs command surface.

## Owns

- Local packaging orchestration for packaged Readable Studio artifacts.
- Windows portable ZIP build/start/stop/logs/cleanup/list/inspect smoke commands.
- Consuming sidecar/process/path primitives from `@readable-studio/sidecar-proto`, `@readable-studio/sidecar`, and `@readable-studio/platform`.

## Does not own

- Product business logic.
- Sidecar protocol definitions.
- A second process identity model.

## Rules

- Do not hand-build `--readable-studio-stamp-*` args; use `createProcessStampArgs` with `SIDECAR_CONTRACT`.
- Do not use port numbers in data/log/runtime/cache path decisions. Namespace decides paths; ports are only transient transports.
- Windows x64 portable ZIP is the only artifact. Do not add target selectors, installers, updaters, or compatibility aliases.
- Pack resource files used by electron-builder belong under `tools/pack/resources/`; do not point pack logic at Downloads, web public assets, docs assets, or other app-owned resource paths.
