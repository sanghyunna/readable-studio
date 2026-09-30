import { build } from "esbuild";

await build({
  banner: {
    js: "#!/usr/bin/env node",
  },
  bundle: true,
  entryPoints: ["./src/index.ts"],
  format: "esm",
  outfile: "./dist/index.mjs",
  packages: "external",
  platform: "node",
  target: "node24",
});

// Generated CommonJS is required by electron-builder's afterPack hook loader.
// The release hook remains unchanged; this entry is used only for profiling.
await build({
  bundle: true,
  entryPoints: ["./src/profile-after-pack.ts"],
  banner: { js: 'const __profileImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__profileImportMetaUrl" },
  footer: { js: "module.exports = module.exports.default;" },
  format: "cjs",
  outfile: "./dist/profile-after-pack.cjs",
  packages: "external",
  platform: "node",
  target: "node24",
});
