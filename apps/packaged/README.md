# apps/packaged

Thin packaged Electron runtime entry for Readable Studio.

This package starts the packaged daemon and web sidecars, registers the `readable-studio://`
entry protocol, and then delegates to `@readable-studio/desktop/main` for the host
window. Product logic stays in `apps/daemon`, `apps/web`, and `apps/desktop`.
