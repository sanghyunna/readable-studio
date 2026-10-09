const { access, copyFile, cp, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");

// A 79-character Downloads extraction root leaves two characters below MAX_PATH.
const PORTABLE_RELATIVE_PATH_BUDGET = 178;
const { availableParallelism } = require("node:os");
const path = require("node:path");

const CONFIG_ENV = "READABLE_TOOLS_PACK_WEB_STANDALONE_HOOK_CONFIG";
const STANDALONE_RESOURCE_NAME = "readable-studio-web-standalone";
const REQUIRED_MODULES = ["next/package.json", "react/package.json", "react-dom/package.json", "styled-jsx/package.json"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record, key) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[tools-pack web-standalone] config.${key} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(record, key) {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`[tools-pack web-standalone] config.${key} must be a boolean`);
  }
  return value;
}

function optionalBoolean(record, key, fallback) {
  const value = record[key];
  if (value == null) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`[tools-pack web-standalone] config.${key} must be a boolean`);
  }
  return value;
}

function requireAbsolutePath(record, key) {
  const value = requireString(record, key);
  if (!path.isAbsolute(value)) {
    throw new Error(`[tools-pack web-standalone] config.${key} must be absolute: ${value}`);
  }
  return path.resolve(value);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isWithinPhysicalPath(parent, child) {
  const [realParent, realChild] = await Promise.all([realpath(parent), realpath(child)]);
  return isWithin(realParent, realChild);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathLstatExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readHookConfig() {
  const configPath = process.env[CONFIG_ENV];
  if (configPath == null || configPath.length === 0) {
    throw new Error(`[tools-pack web-standalone] missing ${CONFIG_ENV}`);
  }
  if (!path.isAbsolute(configPath)) {
    throw new Error(`[tools-pack web-standalone] ${CONFIG_ENV} must be absolute: ${configPath}`);
  }

  const raw = JSON.parse(await readFile(configPath, "utf8"));
  if (!isRecord(raw) || raw.version !== 1) {
    throw new Error("[tools-pack web-standalone] hook config must be an object with version=1");
  }

  const workspaceRoot = requireAbsolutePath(raw, "workspaceRoot");
  const standaloneSourceRoot = requireAbsolutePath(raw, "standaloneSourceRoot");
  const webStaticSourceRoot = requireAbsolutePath(raw, "webStaticSourceRoot");
  const webPublicSourceRoot = requireAbsolutePath(raw, "webPublicSourceRoot");
  const auditReportPath = requireAbsolutePath(raw, "auditReportPath");
  const resourceName = requireString(raw, "resourceName");
  if (resourceName !== STANDALONE_RESOURCE_NAME) {
    throw new Error(`[tools-pack web-standalone] unsupported resourceName: ${resourceName}`);
  }

  for (const [key, value] of Object.entries({ standaloneSourceRoot, webStaticSourceRoot, webPublicSourceRoot })) {
    if (!isWithin(workspaceRoot, value)) {
      throw new Error(`[tools-pack web-standalone] config.${key} must stay under workspaceRoot: ${value}`);
    }
  }

  return {
    auditReportPath,
    pruneCopiedSharp: requireBoolean(raw, "pruneCopiedSharp"),
    pruneRootNext: requireBoolean(raw, "pruneRootNext"),
    pruneRootSharp: requireBoolean(raw, "pruneRootSharp"),
    requireRootWebPackageAudit: optionalBoolean(raw, "requireRootWebPackageAudit", true),
    resourceName,
    standaloneSourceRoot,
    webPublicSourceRoot,
    webStaticSourceRoot,
    workspaceRoot,
  };
}

function resolveAppPath(context) {
  if (context == null || typeof context.appOutDir !== "string" || context.appOutDir.length === 0) {
    throw new Error("[tools-pack web-standalone] electron-builder context.appOutDir is missing");
  }
  const productFilename = context.packager?.appInfo?.productFilename;
  if (typeof productFilename !== "string" || productFilename.length === 0) {
    throw new Error("[tools-pack web-standalone] electron-builder productFilename is missing");
  }
  return context.appOutDir;
}

function resolveResourcesRoot(context) {
  if (context?.electronPlatformName !== "win32") {
    throw new Error(`[tools-pack web-standalone] unsupported platform: ${context?.electronPlatformName ?? "unknown"}`);
  }
  return path.join(context.appOutDir, "resources");
}

function resolveRootAppNodeModulesRoot(resourcesRoot) {
  return path.join(resourcesRoot, "app", "node_modules");
}

// Bound filesystem operations, not just top-level subtrees: a large Next
// package otherwise leaves one reader serially opening thousands of files.
async function visitPaths(root, visit) {
  const pending = [root];
  const concurrency = Math.min(20, availableParallelism());
  let cursor = 0;
  while (cursor < pending.length) {
    const batch = pending.slice(cursor, cursor + concurrency);
    cursor += batch.length;
    const results = await Promise.allSettled(batch.map(visit));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (result.value) pending.push(...result.value);
    }
  }
}

async function childPaths(current) {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  return entries.map((entry) => path.join(current, entry.name));
}

async function sizePathBytes(filePath) {
  let total = 0;
  await visitPaths(filePath, async (current) => {
    const metadata = await lstat(current).catch(() => null);
    if (metadata == null) return;
    if (metadata.isDirectory()) return childPaths(current);
    total += metadata.size;
  });
  return total;
}

async function copyTree(sourcePath, destinationPath, options) {
  const entryTypes = new Map();
  await visitPaths(sourcePath, async (current) => {
    const destination = path.join(destinationPath, path.relative(sourcePath, current));
    const entry = entryTypes.get(current);
    entryTypes.delete(current);
    // The destination was removed by copyRequired. Plain leaves need neither
    // cp's destination/source validation walks nor a second metadata lookup.
    if (entry?.isFile()) {
      await copyFile(current, destination);
      return;
    }
    const metadata = await (options.dereference ? stat(current) : lstat(current));
    if (metadata.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: metadata.mode });
      // Unlike best-effort audit walks, a copy must fail on unreadable sources.
      const entries = await readdir(current, { withFileTypes: true });
      return entries.map((child) => {
        const childPath = path.join(current, child.name);
        entryTypes.set(childPath, child);
        return childPath;
      });
    }
    await cp(current, destination, options);
  });
}

async function copyRequired(sourcePath, destinationPath, options = {}) {
  if (!(await pathExists(sourcePath))) {
    throw new Error(`[tools-pack web-standalone] required source missing: ${sourcePath}`);
  }
  await rm(destinationPath, { force: true, recursive: true });
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyTree(sourcePath, destinationPath, {
    dereference: options.dereference === true,
    recursive: true,
    verbatimSymlinks: options.dereference === true ? false : true,
  });
}

async function copyOptional(sourcePath, destinationPath, options = {}) {
  if (!(await pathExists(sourcePath))) return false;
  await copyRequired(sourcePath, destinationPath, options);
  return true;
}

async function linkRelative(sourcePath, destinationPath, options = {}) {
  if (!(await pathExists(sourcePath))) return false;
  if (await pathLstatExists(destinationPath)) return false;
  await mkdir(path.dirname(destinationPath), { recursive: true });
  if (options.copyInsteadOfSymlink === true) {
    await copyRequired(sourcePath, destinationPath, { dereference: true });
    return true;
  }
  const relativeTarget = path.relative(path.dirname(destinationPath), sourcePath);
  await symlink(relativeTarget.length === 0 ? "." : relativeTarget, destinationPath);
  return true;
}

async function linkPnpmPublicHoist(destinationRoot, options = {}) {
  const nodeModulesRoot = path.join(destinationRoot, "node_modules");
  const hoistRoot = path.join(nodeModulesRoot, ".pnpm", "node_modules");
  const entries = await readdir(hoistRoot, { withFileTypes: true }).catch(() => []);
  const linked = [];

  for (const entry of entries) {
    const sourcePath = path.join(hoistRoot, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      const scopedEntries = await readdir(sourcePath).catch(() => []);
      for (const scopedEntry of scopedEntries) {
        const scopedSource = path.join(sourcePath, scopedEntry);
        const scopedDestination = path.join(nodeModulesRoot, entry.name, scopedEntry);
        if (await linkRelative(scopedSource, scopedDestination, options)) linked.push(scopedDestination);
      }
      continue;
    }

    const destinationPath = path.join(nodeModulesRoot, entry.name);
    if (await linkRelative(sourcePath, destinationPath, options)) linked.push(destinationPath);
  }

  return linked;
}

async function resolveStandaloneSourceWebRoot(standaloneSourceRoot) {
  const candidates = [
    path.join(standaloneSourceRoot, "apps", "web"),
    standaloneSourceRoot,
  ];

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "server.js"))) return candidate;
  }

  throw new Error(`[tools-pack web-standalone] standalone server.js not found under ${standaloneSourceRoot}`);
}

async function installStandaloneResource(config, resourcesRoot, platformName) {
  const sourceWebRoot = await resolveStandaloneSourceWebRoot(config.standaloneSourceRoot);
  const destinationRoot = path.join(resourcesRoot, config.resourceName);
  const destinationWebRoot = path.join(destinationRoot, "apps", "web");
  const copyOptions = { dereference: platformName === "win32" };

  await rm(destinationRoot, { force: true, recursive: true });
  await mkdir(destinationWebRoot, { recursive: true });

  await copyRequired(path.join(config.standaloneSourceRoot, "node_modules"), path.join(destinationRoot, "node_modules"), copyOptions);
  await copyRequired(path.join(sourceWebRoot, "server.js"), path.join(destinationWebRoot, "server.js"));
  await copyOptional(path.join(sourceWebRoot, "package.json"), path.join(destinationWebRoot, "package.json"));
  const copiedNestedNodeModules = await copyOptional(path.join(sourceWebRoot, "node_modules"), path.join(destinationWebRoot, "node_modules"), copyOptions);
  const linkedHoistEntries = await linkPnpmPublicHoist(destinationRoot, { copyInsteadOfSymlink: platformName === "win32" });
  await copyRequired(path.join(sourceWebRoot, ".next"), path.join(destinationWebRoot, ".next"));
  const copiedStatic = await copyOptional(config.webStaticSourceRoot, path.join(destinationWebRoot, ".next", "static"));
  const copiedPublic = await copyOptional(config.webPublicSourceRoot, path.join(destinationWebRoot, "public"));
  const rewrittenSymlinks = platformName === "win32"
    ? []
    : await rewriteCopiedStandaloneSymlinks({
      destinationRoot,
      destinationWebRoot,
      sourceWebRoot,
      standaloneSourceRoot: config.standaloneSourceRoot,
    });

  return {
    copiedNestedNodeModules,
    copiedPublic,
    copiedStatic,
    destinationRoot,
    destinationWebRoot,
    linkedHoistEntries,
    rewrittenSymlinks,
    sourceWebRoot,
  };
}

async function rewriteCopiedStandaloneSymlinks(options) {
  const mappings = [
    {
      destinationRoot: path.join(options.destinationWebRoot, "node_modules"),
      sourceRoot: path.join(options.sourceWebRoot, "node_modules"),
    },
    {
      destinationRoot: path.join(options.destinationRoot, "node_modules"),
      sourceRoot: path.join(options.standaloneSourceRoot, "node_modules"),
    },
    {
      destinationRoot: options.destinationWebRoot,
      sourceRoot: options.sourceWebRoot,
    },
    {
      destinationRoot: options.destinationRoot,
      sourceRoot: options.standaloneSourceRoot,
    },
  ];
  const rewrittenSymlinks = [];

  function mapPath(pathToMap, fromKey, toKey) {
    for (const mapping of mappings) {
      if (!isWithin(mapping[fromKey], pathToMap)) continue;
      return path.join(mapping[toKey], path.relative(mapping[fromKey], pathToMap));
    }
    return null;
  }

  async function visit(current) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      return;
    }

    if (metadata.isSymbolicLink()) {
      const copiedSourcePath = mapPath(current, "destinationRoot", "sourceRoot");
      if (copiedSourcePath == null) return;

      const currentTarget = await readlink(current);
      const sourceTarget = path.resolve(path.dirname(copiedSourcePath), currentTarget);
      const destinationTarget = mapPath(sourceTarget, "sourceRoot", "destinationRoot");
      // External source-tree symlinks are not rewritten; the closure audit below
      // reports them as externalSymlink and fails the package instead.
      if (destinationTarget == null) return;

      const nextTarget = path.relative(path.dirname(current), destinationTarget) || ".";
      if (nextTarget === currentTarget) return;

      await rm(current, { force: true, recursive: true });
      await symlink(nextTarget, current);
      rewrittenSymlinks.push({
        path: current,
        target: nextTarget,
      });
      return;
    }

    if (!metadata.isDirectory()) return;

    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      await visit(path.join(current, entry.name));
    }
  }

  await visit(options.destinationRoot);
  return rewrittenSymlinks;
}

async function removePathAndRecord(targetPath, reason, removedPaths) {
  const existed = await pathExists(targetPath);
  const bytes = await sizePathBytes(targetPath);
  await rm(targetPath, { force: true, recursive: true });
  if (existed || bytes > 0) {
    removedPaths.push({ bytes, path: targetPath, reason });
  }
}

function isPrunablePnpmSharpEntry(name) {
  return name.startsWith("sharp@") || name.startsWith("@img+colour@") || name.startsWith("@img+sharp-");
}

function isPrunableImgEntry(name) {
  return name === "colour" || name.startsWith("sharp-");
}

async function pruneImgScope(scopePath, reason, removedPaths) {
  const entries = await readdir(scopePath).catch(() => []);
  for (const entry of entries) {
    if (isPrunableImgEntry(entry)) {
      await removePathAndRecord(path.join(scopePath, entry), reason, removedPaths);
    }
  }
}

async function pruneCopiedSharp(destinationRoot) {
  const nodeModulesRoot = path.join(destinationRoot, "node_modules");
  const pnpmRoot = path.join(nodeModulesRoot, ".pnpm");
  const removedPaths = [];

  await removePathAndRecord(path.join(nodeModulesRoot, "sharp"), "copied top-level sharp symlink", removedPaths);
  await pruneImgScope(path.join(nodeModulesRoot, "@img"), "copied top-level @img sharp symlink", removedPaths);
  await removePathAndRecord(path.join(pnpmRoot, "node_modules", "sharp"), "copied pnpm sharp symlink", removedPaths);
  await pruneImgScope(path.join(pnpmRoot, "node_modules", "@img"), "copied pnpm @img sharp symlink", removedPaths);

  const pnpmEntries = await readdir(pnpmRoot).catch(() => []);
  for (const entry of pnpmEntries) {
    if (isPrunablePnpmSharpEntry(entry)) {
      await removePathAndRecord(path.join(pnpmRoot, entry), "copied pnpm sharp package", removedPaths);
      continue;
    }

    if (entry.startsWith("next@")) {
      await removePathAndRecord(path.join(pnpmRoot, entry, "node_modules", "sharp"), "copied next sharp symlink", removedPaths);
    }
  }

  return removedPaths;
}

async function dedupeCopiedStandaloneNext(destinationRoot, destinationWebRoot, platformName) {
  if (platformName !== "win32") return null;

  const nodeModulesRoot = path.join(destinationRoot, "node_modules");
  const rootNextRoot = path.join(nodeModulesRoot, "next");
  const pnpmHoistedNextRoot = path.join(nodeModulesRoot, ".pnpm", "node_modules", "next");
  const webNextRoot = path.join(destinationWebRoot, "node_modules", "next");
  const removedPaths = [];

  if (!(await pathExists(path.join(webNextRoot, "package.json")))) {
    throw new Error(`[tools-pack web-standalone] copied standalone app-local Next package missing: ${webNextRoot}`);
  }

  await removePathAndRecord(
    rootNextRoot,
    "copied standalone root next public-hoist duplicate",
    removedPaths,
  );
  await removePathAndRecord(
    pnpmHoistedNextRoot,
    "copied standalone pnpm-hoisted next duplicate superseded by app-local next",
    removedPaths,
  );

  // Windows copies are dereferenced. Moving the retained copy up preserves Node's
  // ancestor lookup while removing apps/web from every Next package path.
  await rename(webNextRoot, rootNextRoot);
  return {
    removedPaths,
    retainedPath: rootNextRoot,
  };
}

async function pruneBrokenSymlinks(root, current = root, removedPaths = [], reason = "broken symlink") {
  let metadata;
  try {
    metadata = await lstat(current);
  } catch {
    return removedPaths;
  }

  if (metadata.isSymbolicLink()) {
    try {
      await stat(current);
    } catch {
      await removePathAndRecord(current, reason, removedPaths);
    }
    return removedPaths;
  }

  if (!metadata.isDirectory()) return removedPaths;

  await visitPaths(current, async (entryPath) => {
    const entryMetadata = await lstat(entryPath).catch(() => null);
    if (entryMetadata == null) return;
    if (entryMetadata.isSymbolicLink()) {
      try { await stat(entryPath); }
      catch { await removePathAndRecord(entryPath, reason, removedPaths); }
    } else if (entryMetadata.isDirectory()) {
      return childPaths(entryPath);
    }
  });
  return removedPaths;
}

function isSourceBuildResidue(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized.endsWith(".map") || normalized.endsWith(".tsbuildinfo");
}

async function pruneMatchingFilesSummary(root, includeRelativePath, reason) {
  const summary = {
    bytes: 0,
    count: 0,
    reason,
    root,
  };

  await visitPaths(root, async (current) => {
    const metadata = await lstat(current).catch(() => null);
    if (metadata == null) return;
    if (metadata.isDirectory()) return childPaths(current);

    const relativePath = path.relative(root, current);
    if (relativePath.length === 0 || !includeRelativePath(relativePath)) return;
    summary.bytes += metadata.size;
    summary.count += 1;
    await rm(current, { force: true });
  });
  return summary.count > 0 ? [summary] : [];
}

async function pruneSourceBuildResidue(root, reason) {
  return await pruneMatchingFilesSummary(root, isSourceBuildResidue, reason);
}

function isForbiddenCopiedEntry(relativePath, platformName) {
  const normalized = relativePath.split(path.sep).join("/");
  const withRootSlash = `/${normalized}`;
  const forbiddenSwc = withRootSlash.includes("swc-darwin") || withRootSlash.includes("swc-linux");
  return (
    withRootSlash.includes("/node_modules/.pnpm/sharp@") ||
    withRootSlash.includes("/node_modules/.pnpm/@img+colour@") ||
    withRootSlash.includes("/node_modules/.pnpm/@img+sharp-") ||
    withRootSlash.includes("/node_modules/sharp") ||
    withRootSlash.includes("/node_modules/@img/colour") ||
    withRootSlash.includes("/node_modules/@img/sharp-") ||
    withRootSlash.includes("sharp-libvips") ||
    forbiddenSwc
  );
}

async function collectClosureStats(
  root,
  current = root,
  stats = { brokenSymlinks: [], externalSymlinks: [], forbiddenEntries: [], symlinks: 0 },
  platformName = process.platform,
) {
  await visitPaths(current, async (entryPath) => {
    const metadata = await lstat(entryPath).catch(() => null);
    if (metadata == null) return;
    const relativePath = path.relative(root, entryPath);
    if (relativePath.length > 0 && isForbiddenCopiedEntry(relativePath, platformName)) {
      stats.forbiddenEntries.push(relativePath.split(path.sep).join("/"));
    }
    if (!metadata.isDirectory() && stats.sizeRoots) {
      for (const [sizeRoot, total] of stats.sizeRoots) {
        if (isWithin(sizeRoot, entryPath)) stats.sizeRoots.set(sizeRoot, total + metadata.size);
      }
    }
    if (metadata.isSymbolicLink()) {
      stats.symlinks += 1;
      try {
        await stat(entryPath);
        if (!(await isWithinPhysicalPath(root, entryPath))) {
          stats.externalSymlinks.push(relativePath.split(path.sep).join("/"));
        }
      } catch {
        stats.brokenSymlinks.push(relativePath.split(path.sep).join("/"));
      }
    } else if (metadata.isDirectory()) {
      return childPaths(entryPath);
    }
  });
  return stats;
}

async function assertResolvedInside(root, moduleName, resolvedPath) {
  if (!(await isWithinPhysicalPath(root, resolvedPath))) {
    throw new Error(`[tools-pack web-standalone] ${moduleName} resolved outside copied standalone: ${resolvedPath}`);
  }
}

async function auditCopiedStandalone(config, installResult, platformName) {
  const serverPath = path.join(installResult.destinationWebRoot, "server.js");
  const staticRoot = path.join(installResult.destinationWebRoot, ".next", "static");
  const publicRoot = path.join(installResult.destinationWebRoot, "public");
  const nodeModulesRoot = path.join(installResult.destinationRoot, "node_modules");
  const webNodeModulesRoot = path.join(installResult.destinationWebRoot, "node_modules");
  const requiredPaths = [serverPath, staticRoot, nodeModulesRoot];
  if (await pathExists(config.webPublicSourceRoot)) requiredPaths.push(publicRoot);

  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(requiredPath))) {
      throw new Error(`[tools-pack web-standalone] copied standalone audit missing: ${requiredPath}`);
    }
  }

  const localRequire = createRequire(serverPath);
  const resolvedModules = {};
  for (const moduleName of REQUIRED_MODULES) {
    const resolvedPath = localRequire.resolve(moduleName);
    await assertResolvedInside(installResult.destinationRoot, moduleName, resolvedPath);
    resolvedModules[moduleName] = resolvedPath;
  }

  const webNextRoot = path.join(webNodeModulesRoot, "next");
  const sizeRoots = new Map([installResult.destinationRoot, nodeModulesRoot, webNextRoot, webNodeModulesRoot].map((root) => [root, 0]));
  const closureStats = await collectClosureStats(installResult.destinationRoot, installResult.destinationRoot,
    { brokenSymlinks: [], externalSymlinks: [], forbiddenEntries: [], symlinks: 0, sizeRoots }, platformName);
  if (closureStats.brokenSymlinks.length > 0) {
    throw new Error(`[tools-pack web-standalone] copied standalone has broken symlinks: ${closureStats.brokenSymlinks.join(", ")}`);
  }
  if (closureStats.externalSymlinks.length > 0) {
    throw new Error(`[tools-pack web-standalone] copied standalone has external symlinks: ${closureStats.externalSymlinks.join(", ")}`);
  }
  if (closureStats.forbiddenEntries.length > 0) {
    throw new Error(`[tools-pack web-standalone] copied standalone has forbidden entries: ${closureStats.forbiddenEntries.join(", ")}`);
  }

  return {
    brokenSymlinks: closureStats.brokenSymlinks,
    bytes: sizeRoots.get(installResult.destinationRoot),
    destinationRoot: installResult.destinationRoot,
    destinationWebRoot: installResult.destinationWebRoot,
    externalSymlinks: closureStats.externalSymlinks,
    forbiddenEntries: closureStats.forbiddenEntries,
    nodeModulesBytes: sizeRoots.get(nodeModulesRoot),
    resolvedModules,
    serverPath,
    symlinks: closureStats.symlinks,
    webNextBytes: sizeRoots.get(webNextRoot),
    webNodeModulesBytes: sizeRoots.get(webNodeModulesRoot),
  };
}

async function auditCopiedStandaloneNextDedupe(installResult, platformName) {
  if (platformName !== "win32") return null;

  const serverPath = path.join(installResult.destinationWebRoot, "server.js");
  const retainedNextRoot = path.join(installResult.destinationRoot, "node_modules", "next");
  const retainedNextPackagePath = path.join(retainedNextRoot, "package.json");
  const checkedPaths = [
    path.join(installResult.destinationWebRoot, "node_modules", "next"),
    path.join(installResult.destinationRoot, "node_modules", ".pnpm", "node_modules", "next"),
  ];
  const remainingPaths = [];

  for (const checkedPath of checkedPaths) {
    if (await pathExists(checkedPath)) remainingPaths.push(checkedPath);
  }
  if (remainingPaths.length > 0) {
    throw new Error(
      `[tools-pack web-standalone] copied standalone next dedupe audit found remaining duplicate paths: ${remainingPaths.join(", ")}`,
    );
  }

  if (!(await pathExists(retainedNextPackagePath))) {
    throw new Error(`[tools-pack web-standalone] copied standalone retained app-local next missing: ${retainedNextPackagePath}`);
  }

  const resolvedNextPackagePath = createRequire(serverPath).resolve("next/package.json");
  if (!(await isWithinPhysicalPath(retainedNextRoot, resolvedNextPackagePath))) {
    throw new Error(
      `[tools-pack web-standalone] copied standalone next resolved outside retained app-local next: ${resolvedNextPackagePath}`,
    );
  }

  return {
    checkedPaths,
    remainingPaths,
    resolvedNextPackagePath,
    retainedNextRoot,
  };
}

async function pruneRootNext(appNodeModulesRoot, platformName) {
  const removedPaths = [];

  await removePathAndRecord(
    path.join(appNodeModulesRoot, "next"),
    "root next package superseded by copied standalone resource",
    removedPaths,
  );
  await removePathAndRecord(
    path.join(appNodeModulesRoot, "@next"),
    "root @next package scope superseded by copied standalone resource",
    removedPaths,
  );

  await removePathAndRecord(
    path.join(appNodeModulesRoot, "@readable-studio", "web", ".next", "standalone"),
    "root @readable-studio/web standalone output",
    removedPaths,
  );

  return removedPaths;
}

async function auditRootNextPruned(appNodeModulesRoot, platformName, enabled) {
  if (platformName !== "win32" || !enabled) return null;

  const checkedPaths = [
    path.join(appNodeModulesRoot, "next"),
    path.join(appNodeModulesRoot, "@next"),
  ];
  const remainingPaths = [];
  for (const checkedPath of checkedPaths) {
    if (await pathExists(checkedPath)) remainingPaths.push(checkedPath);
  }
  if (remainingPaths.length > 0) {
    throw new Error(`[tools-pack web-standalone] root next pruning audit found remaining paths: ${remainingPaths.join(", ")}`);
  }

  return {
    checkedPaths,
    remainingPaths,
  };
}

async function pruneRootSharp(appNodeModulesRoot) {
  const pnpmRoot = path.join(appNodeModulesRoot, ".pnpm");
  const removedPaths = [];

  await removePathAndRecord(path.join(appNodeModulesRoot, "sharp"), "root sharp package", removedPaths);
  await pruneImgScope(path.join(appNodeModulesRoot, "@img"), "root @img sharp package", removedPaths);
  await removePathAndRecord(path.join(pnpmRoot, "node_modules", "sharp"), "root pnpm sharp symlink", removedPaths);
  await pruneImgScope(path.join(pnpmRoot, "node_modules", "@img"), "root pnpm @img sharp symlink", removedPaths);

  const pnpmEntries = await readdir(pnpmRoot).catch(() => []);
  for (const entry of pnpmEntries) {
    if (isPrunablePnpmSharpEntry(entry)) {
      await removePathAndRecord(path.join(pnpmRoot, entry), "root pnpm sharp package", removedPaths);
    }
  }

  return removedPaths;
}

async function pruneRootWebPackage(appNodeModulesRoot, platformName) {
  if (platformName !== "win32") return [];

  const webPackageRoot = path.join(appNodeModulesRoot, "@readable-studio", "web");
  const removedPaths = [];
  for (const entry of [".next", "app", "next.config.ts", "public", "src"]) {
    await removePathAndRecord(
      path.join(webPackageRoot, entry),
      "root @readable-studio/web standalone-safe package residue",
      removedPaths,
    );
  }
  return removedPaths;
}

async function auditRootWebPackage(appNodeModulesRoot) {
  const webPackageRoot = path.join(appNodeModulesRoot, "@readable-studio", "web");
  const packageJsonPath = path.join(webPackageRoot, "package.json");
  const sidecarEntryPath = path.join(webPackageRoot, "dist", "sidecar", "index.js");
  for (const requiredPath of [packageJsonPath, sidecarEntryPath]) {
    if (!(await pathExists(requiredPath))) {
      throw new Error(`[tools-pack web-standalone] root @readable-studio/web audit missing: ${requiredPath}`);
    }
  }
  return {
    bytes: await sizePathBytes(webPackageRoot),
    packageJsonPath,
    retainedDistBytes: await sizePathBytes(path.join(webPackageRoot, "dist")),
    sidecarEntryPath,
    webPackageRoot,
  };
}

async function auditNoBrokenSymlinks(root, label) {
  const stats = await collectClosureStats(root);
  if (stats.brokenSymlinks.length > 0) {
    throw new Error(`[tools-pack web-standalone] ${label} has broken symlinks: ${stats.brokenSymlinks.join(", ")}`);
  }
  return {
    brokenSymlinks: stats.brokenSymlinks,
    symlinks: stats.symlinks,
  };
}

async function shortenCopiedVirtualStore(destinationRoot) {
  const store = path.join(destinationRoot, "node_modules", ".pnpm");
  const renamedPaths = [];
  // Only Windows' fully dereferenced copies reach here: there are no store links
  // to retarget, and each package keeps the same node_modules ancestor depth.
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.length <= 32) continue;
    const name = `p${createHash("sha256").update(entry.name).digest("hex").slice(0, 6)}`;
    const from = path.join(store, entry.name);
    const to = path.join(store, name);
    if (await pathLstatExists(to)) throw new Error(`[tools-pack] virtual store collision: ${to}`);
    await rename(from, to);
    renamedPaths.push({ from, to });
  }
  return renamedPaths;
}

async function auditPortablePaths(appOutDir) {
  const offendingPaths = [];
  let maxLength = 0;
  let files = 0;
  await visitPaths(appOutDir, async (current) => {
    const metadata = await lstat(current);
    const relative = path.posix.join("app", path.relative(appOutDir, current).split(path.sep).join("/"));
    maxLength = Math.max(maxLength, relative.length);
    if (relative.length > PORTABLE_RELATIVE_PATH_BUDGET) offendingPaths.push(relative);
    if (metadata.isDirectory()) return childPaths(current);
    files += 1;
  });
  if (offendingPaths.length) {
    throw new Error(`[tools-pack] portable path budget ${PORTABLE_RELATIVE_PATH_BUDGET} exceeded: ${offendingPaths.join(", ")}`);
  }
  return { budget: PORTABLE_RELATIVE_PATH_BUDGET, files, maxLength };
}

async function runWebStandaloneAfterPack(context) {
  if (context?.electronPlatformName != null && context.electronPlatformName !== "win32") return;

  const config = await readHookConfig();
  const appPath = resolveAppPath(context);
  const resourcesRoot = resolveResourcesRoot(context);
  if (!(await pathExists(resourcesRoot))) {
    throw new Error(`[tools-pack web-standalone] resources root not found: ${resourcesRoot}`);
  }

  const appNodeModulesRoot = resolveRootAppNodeModulesRoot(resourcesRoot);
  const installResult = await installStandaloneResource(config, resourcesRoot, context.electronPlatformName);
  const copiedPrune = config.pruneCopiedSharp ? await pruneCopiedSharp(installResult.destinationRoot) : [];
  const copiedNextDedupe = await dedupeCopiedStandaloneNext(
    installResult.destinationRoot,
    installResult.destinationWebRoot,
    context.electronPlatformName,
  );
  const copiedBuildResiduePrune = await pruneSourceBuildResidue(
    installResult.destinationRoot,
    "copied standalone source/build residue",
  );
  const brokenSymlinkPrune = await pruneBrokenSymlinks(
    installResult.destinationRoot,
    installResult.destinationRoot,
    [],
    "copied broken symlink",
  );
  const virtualStoreRenames = context.electronPlatformName === "win32"
    ? await shortenCopiedVirtualStore(installResult.destinationRoot)
    : [];
  const copiedNextDedupeAudit = await auditCopiedStandaloneNextDedupe(
    installResult,
    context.electronPlatformName,
  );
  const copiedAudit = await auditCopiedStandalone(config, installResult, context.electronPlatformName);
  const rootPrune = config.pruneRootNext ? await pruneRootNext(appNodeModulesRoot, context.electronPlatformName) : [];
  const rootSharpPrune = config.pruneRootSharp ? await pruneRootSharp(appNodeModulesRoot) : [];
  const rootWebPackagePrune = await pruneRootWebPackage(appNodeModulesRoot, context.electronPlatformName);
  const rootBuildResiduePrune = await pruneSourceBuildResidue(
    appNodeModulesRoot,
    "root app source/build residue",
  );
  const rootWebPackageAudit = config.requireRootWebPackageAudit ? await auditRootWebPackage(appNodeModulesRoot) : null;
  const rootNextPruneAudit = await auditRootNextPruned(
    appNodeModulesRoot,
    context.electronPlatformName,
    config.pruneRootNext,
  );
  const rootBrokenSymlinkPrune = await pruneBrokenSymlinks(
    appNodeModulesRoot,
    appNodeModulesRoot,
    [],
    "root broken symlink",
  );
  const rootSymlinkAudit = await auditNoBrokenSymlinks(
    appNodeModulesRoot,
    "root app node_modules",
  );
  const portablePathAudit = await auditPortablePaths(appPath);
  const report = {
    portablePathAudit,
    virtualStoreRenames,
    appPath,
    brokenSymlinkPrune,
    copiedAudit,
    copiedBuildResiduePrune,
    copiedNextDedupe,
    copiedNextDedupeAudit,
    copiedPrune,
    generatedAt: new Date().toISOString(),
    platformName: context.electronPlatformName,
    resourcesRoot,
    rootBuildResiduePrune,
    rootBrokenSymlinkPrune,
    rootNextPruneAudit,
    rootPrune,
    rootSharpPrune,
    rootSymlinkAudit,
    rootWebPackageAudit,
    rootWebPackagePrune,
    sourceWebRoot: installResult.sourceWebRoot,
    version: 1,
  };

  await mkdir(path.dirname(config.auditReportPath), { recursive: true });
  await writeFile(config.auditReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

module.exports = async function webStandaloneAfterPack(context) {
  try {
    await runWebStandaloneAfterPack(context);
  } catch (error) {
    console.error(
      "[tools-pack web-standalone] after-pack hook failed:",
      error instanceof Error ? error.message : error,
    );
    console.error("[tools-pack web-standalone] electron-builder context:", {
      appOutDir: context?.appOutDir,
      electronPlatformName: context?.electronPlatformName,
      productFilename: context?.packager?.appInfo?.productFilename,
    });
    throw error;
  }
};
