import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
export const PI_PACKAGE_VERSION = '0.83.0';
export const PI_RPC_ENTRYPOINT = path.join('dist', 'rpc-entry.js');

export type PiPackage = { packageRoot: string; entrypoint: string };

function defaultPackageRoot(): string {
  const packageEntry = fileURLToPath(import.meta.resolve(`${PI_PACKAGE_NAME}/rpc-entry`));
  return path.resolve(path.dirname(packageEntry), '..');
}

/** Resolve only the pinned, package-local RPC engine, never a global Pi CLI. */
export function resolvePiEntrypoint(packageRoot = defaultPackageRoot()): PiPackage {
  if (!path.isAbsolute(packageRoot)) throw new Error('package root must be absolute');
  let root: string;
  try {
    if (!statSync(packageRoot).isDirectory()) throw new Error('package root must be a directory');
    root = realpathSync(packageRoot);
  } catch (error) {
    throw new Error(`hosted Pi package root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`hosted Pi package manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.name !== PI_PACKAGE_NAME || manifest.version !== PI_PACKAGE_VERSION) {
    throw new Error(`hosted Pi package must be ${PI_PACKAGE_NAME}@${PI_PACKAGE_VERSION}`);
  }
  const entrypoint = path.join(root, PI_RPC_ENTRYPOINT);
  let resolvedEntrypoint: string;
  try {
    if (!statSync(entrypoint).isFile()) throw new Error('entrypoint is not a file');
    resolvedEntrypoint = realpathSync(entrypoint);
  } catch (error) {
    throw new Error(`hosted Pi package-local RPC entrypoint is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const relative = path.relative(root, resolvedEntrypoint);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('hosted Pi package-local RPC entrypoint escapes the pinned package root');
  }
  return { packageRoot: root, entrypoint: resolvedEntrypoint };
}
