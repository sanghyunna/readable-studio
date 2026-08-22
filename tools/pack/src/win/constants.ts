export { PRODUCT_NAME } from "@readable-studio/product-identity";
export const RESOURCE_TREE_NAME = "readable-studio";
export const DESKTOP_LOG_ECHO_ENV = "READABLE_DESKTOP_LOG_ECHO";
export const WEB_STANDALONE_HOOK_CONFIG_ENV = "READABLE_TOOLS_PACK_WEB_STANDALONE_HOOK_CONFIG";
export const WEB_STANDALONE_RESOURCE_NAME = "readable-studio-web-standalone";
export const ELECTRON_BUILDER_ASAR = false;
export const ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE = false;
export const ELECTRON_BUILDER_NODE_GYP_REBUILD = false;
export const ELECTRON_BUILDER_NPM_REBUILD = false;
export const ELECTRON_REBUILD_MODE = "sequential" as const;
// Windows daemon/web sidecars run under the packaged Node runtime, not as
// Electron renderer/native modules. Rebuilding better-sqlite3 to Electron's ABI
// makes the daemon crash at startup with NODE_MODULE_VERSION mismatch.
export const ELECTRON_REBUILD_NATIVE_MODULES = [] as const;
export const ELECTRON_BUILDER_FILE_PATTERNS = [
  "**/*",
  "!**/node_modules/.bin",
  "!**/node_modules/electron{,/**/*}",
  "!**/*.map",
  "!**/*.tsbuildinfo",
  "!**/.next/cache",
  "!**/.next/cache/**",
  "!**/node_modules/better-sqlite3/build/Release/obj",
  "!**/node_modules/better-sqlite3/build/Release/obj/**",
  "!**/node_modules/better-sqlite3/deps",
  "!**/node_modules/better-sqlite3/deps/**",
] as const;
export const INTERNAL_PACKAGES = [
  { directory: "packages/components", name: "@readable-studio/components" },
  { directory: "packages/contracts", name: "@readable-studio/contracts" },
  { directory: "packages/registry-protocol", name: "@readable-studio/registry-protocol" },
  { directory: "packages/sidecar-proto", name: "@readable-studio/sidecar-proto" },
  { directory: "packages/sidecar", name: "@readable-studio/sidecar" },
  { directory: "packages/platform", name: "@readable-studio/platform" },
  { directory: "packages/download", name: "@readable-studio/download" },
  { directory: "packages/host", name: "@readable-studio/host" },
  { directory: "packages/agui-adapter", name: "@readable-studio/agui-adapter" },
  { directory: "packages/plugin-runtime", name: "@readable-studio/plugin-runtime" },
  { directory: "packages/product-identity", name: "@readable-studio/product-identity" },
  { directory: "packages/diagnostics", name: "@readable-studio/diagnostics" },
  { directory: "apps/daemon", name: "@readable-studio/daemon" },
  { directory: "apps/web", name: "@readable-studio/web" },
  { directory: "apps/desktop", name: "@readable-studio/desktop" },
  { directory: "apps/packaged", name: "@readable-studio/packaged" },
] as const;
