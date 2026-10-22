import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// Audited build entrypoints, not a snapshot of existing source filenames.
// tsconfig and package.json below add their declared input roots on every call.
// Packages without a pack allowlist deliberately keep the whole source tree.
const productionRoots: Record<string, string[]> = {
  "agui-adapter": ["src", "esbuild.config.mjs"],
  "components": ["src", "esbuild.config.ts"],
  "contracts": ["src", "esbuild.config.mjs"],
  "diagnostics": ["src", "esbuild.config.mjs"],
  "download": ["src", "esbuild.config.mjs"],
  "host": ["src", "esbuild.config.mjs"],
  "html-edit": ["src"],
  "metatool": ["src", "esbuild.config.mjs"],
  "platform": ["src", "esbuild.config.mjs", "native"],
  "plugin-runtime": ["src", "esbuild.config.mjs"],
  "product-identity": ["src", "product-identity.json"],
  "registry-protocol": ["src", "esbuild.config.mjs"],
  "sidecar": ["src", "esbuild.config.mjs"],
  "sidecar-proto": ["src", "esbuild.config.mjs"],
  "daemon": ["src", "bin"],
  "desktop": ["src", "assets"],
  "packaged": ["src", "esbuild.config.mjs"],
  "web": ["app", "src", "sidecar", "public", "tests", "next-env.d.ts",
    "next.config.ts", "postcss.config.mjs", "tsconfig.sidecar.json",
    ".env", ".env.local", ".env.production", ".env.production.local"],
};

const generatedRoots = new Set([".next", ".readable-studio", "dist", "node_modules", "out"]);

type PackageManifest = {
  name?: string;
  files?: string[];
  bin?: string | Record<string, string>;
  main?: string;
  types?: string;
  exports?: unknown;
  scripts?: Record<string, string>;
};

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalizeRelativePath(path: string): string {
  return path.split("\\").join("/");
}

export async function hashPackageSourcePath(path: string): Promise<string> {
  const hash = createHash("sha256");
  const packageRoot = resolve(path);
  const metadata = await lstat(packageRoot);
  const manifestText = metadata.isDirectory() ? await optionalFile(join(packageRoot, "package.json")) : null;
  const manifest = manifestText == null ? null : JSON.parse(manifestText) as PackageManifest;
  const name = manifest?.name?.replace(/^@readable-studio\//, "");
  const audited = manifest?.name?.startsWith("@readable-studio/") && name != null
    ? productionRoots[name] : undefined;
  const roots = new Set<string>();
  const addRoot = (input: string, base = packageRoot): void => {
    if (input.startsWith("!")) return;
    // A positive glob contributes its entire static directory prefix. This
    // deliberately includes non-TS runtime data and files added after this run.
    const parts = normalizeRelativePath(input).split("/");
    const wildcard = parts.findIndex((part) => /[*?[\]{}]/.test(part));
    const prefix = wildcard < 0 ? input : parts.slice(0, wildcard).join("/") || ".";
    const absolute = resolve(base, prefix);
    const local = normalizeRelativePath(relative(packageRoot, absolute));
    if (generatedRoots.has(local.split("/")[0]!)) return;
    roots.add(absolute);
  };

  if (audited == null || manifest?.files == null) {
    roots.add(packageRoot);
  } else {
    for (const input of [...audited, "package.json", "tsconfig.json", ".npmignore", ".gitignore"]) addRoot(input);
    for (const input of manifest.files) addRoot(input);
    const addExports = (value: unknown): void => {
      if (typeof value === "string") addRoot(value);
      else if (value != null && typeof value === "object") Object.values(value).forEach(addExports);
    };
    addExports(manifest.bin);
    addExports(manifest.exports);
    if (manifest.main != null) addRoot(manifest.main);
    if (manifest.types != null) addRoot(manifest.types);
    // pnpm pack includes these even when they are absent from `files`.
    for (const entry of await readdir(packageRoot)) {
      if (/^(readme|licen[cs]e|copying|notice)([.-]|$)/i.test(entry)) addRoot(entry);
    }
    // Local build/pack hooks may introduce a new script without changing this
    // policy. Include its directory, so imported helpers are covered as well.
    for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
      if (!/^(pre|post)?build(?::|$)|^(prepack|postpack|prepare)$/.test(script)) continue;
      for (const match of command.matchAll(/(?:^|[\s"'=])(\.{1,2}\/[^\s"';&]+)/g)) {
        const input = match[1]!;
        addRoot(input);
        if (dirname(input) !== ".") addRoot(dirname(input));
      }
      // Bare relative tokens (scripts/x.ts) count only when they name an
      // existing file inside the package, so words like "tsc" are ignored.
      for (const match of command.matchAll(/(?:^|[\s"'=])([^\s"';&|<>$=:\\-][^\s"';&|<>$=:\\]*)/g)) {
        const input = match[1]!;
        if (/^\.{1,2}\//.test(input) || isAbsolute(input)) continue;
        const absolute = resolve(packageRoot, input);
        const local = relative(packageRoot, absolute);
        if (local === "" || local.startsWith("..") || isAbsolute(local)) continue;
        if (!(await stat(absolute).then((entry) => entry.isFile(), () => false))) continue;
        addRoot(input);
        if (dirname(input) !== ".") addRoot(dirname(input));
      }
    }
    const configs = new Set<string>();
    const addConfig = async (configPath: string): Promise<void> => {
      if (configs.has(configPath)) return;
      configs.add(configPath);
      roots.add(configPath);
      const text = await optionalFile(configPath);
      if (text == null) return;
      // Workspace configs are JSON. Do not silently omit inputs on parse errors.
      const config = JSON.parse(text) as { include?: string[]; files?: string[]; extends?: string | string[] };
      for (const input of [...(config.include ?? []), ...(config.files ?? [])]) addRoot(input, dirname(configPath));
      if (config.include == null && config.files == null && config.extends == null) addRoot(".", dirname(configPath));
      for (const parent of typeof config.extends === "string" ? [config.extends] : config.extends ?? []) {
        if (!parent.startsWith(".")) throw new Error(`Unsupported non-relative source-hash tsconfig extends: ${parent}`);
        await addConfig(resolve(dirname(configPath), parent.endsWith(".json") ? parent : `${parent}.json`));
      }
    };
    for (const root of [...roots]) {
      if (/[/\\]tsconfig[^/\\]*\.json$/.test(root)) await addConfig(root);
    }
  }

  // These inputs affect both compilation and pnpm pack. Include them here too:
  // callers other than workspace-build must not lose lock/toolchain invalidation.
  if (manifest != null) {
    const workspaceRoot = name === "e2e" ? dirname(packageRoot) : dirname(dirname(packageRoot));
    for (const input of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches"]) {
      roots.add(join(workspaceRoot, input));
    }
    hash.update(JSON.stringify({ schema: 2, node: process.version, platform: process.platform, arch: process.arch }));
  }

  async function visit(current: string, root: string): Promise<void> {
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const relativePath = normalizeRelativePath(relative(root, current));
    hash.update(JSON.stringify(relativePath));
    if (metadata == null) {
      hash.update("missing");
      return;
    }
    if (metadata.isSymbolicLink()) {
      hash.update("symlink");
      hash.update(JSON.stringify(await readlink(current)));
      return;
    }
    if (!metadata.isDirectory()) {
      hash.update("file");
      const contents = await readFile(current);
      hash.update(`${contents.length}:`);
      hash.update(contents);
      return;
    }
    hash.update("dir");
    const entries = (await readdir(current)).sort();
    for (const entry of entries) {
      // Only generated package roots are excluded: src/vendor/dist or
      // public/node_modules may be real, shipped runtime inputs.
      if (current === packageRoot && generatedRoots.has(entry)) continue;
      await visit(join(current, entry), root);
    }
  }

  const ordered = [...roots].sort();
  for (const input of ordered) {
    if (ordered.some((parent) => parent !== input
      && normalizeRelativePath(input).startsWith(`${normalizeRelativePath(parent)}/`))) continue;
    await visit(input, packageRoot);
  }
  return hash.digest("hex");
}
