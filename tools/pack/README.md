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

Extract the portable ZIP anywhere on Windows and run the executable directly.
The build always produces that portable artifact; tools-pack has no installer,
updater, alternate target, or compatibility mode.

Windows portable archives retain the shared bundled resource trees and generic
sidecar/platform runtime primitives used by the packaged application.
