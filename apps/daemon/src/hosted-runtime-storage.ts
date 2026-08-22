import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { openHostedDatabaseAtPath } from './db.js';

const IDENTITY_MARKER = '.identity.json';
const IDENTITY_MARKER_MAX_BYTES = 4 * 1024;

export interface HostedStorageIdentity {
  readonly userKey: string;
  readonly storageKey: string;
}

export interface HostedRuntimeRoots {
  readonly liveRoot: string;
  readonly databaseFile: string;
  readonly projectsRoot: string;
  readonly artifactsRoot: string;
  readonly uploadsRoot: string;
  readonly checkpointsRoot: string;
  readonly sessionsRoot: string;
  readonly runsRoot: string;
  readonly brokerRoot: string;
}

export interface HostedRuntimeStorage {
  readonly database: Database.Database;
  readonly roots: HostedRuntimeRoots;
  close(): void;
}

export interface HostedRuntimeStorageOptions {
  readonly runtimeRoot: string;
  readonly identity: HostedStorageIdentity;
  /** Database system-boundary seam used to prove failed-open cleanup. */
  readonly databaseOpener?: typeof openHostedDatabaseAtPath;
}

interface IdentityMarker {
  readonly derivationVersion: 1;
  readonly userKey: string;
  readonly storageKey: string;
}

export function createHostedRuntimeStorage(
  options: HostedRuntimeStorageOptions,
): HostedRuntimeStorage {
  validateIdentity(options.identity);
  const runtimeRoot = prepareBaseDirectory(options.runtimeRoot);
  const liveRoot = ensureChildDirectory(runtimeRoot, 'live').path;
  const storageRootState = ensureChildDirectory(liveRoot, options.identity.storageKey);
  ensureIdentityMarker(storageRootState.path, options.identity, storageRootState.created);

  const generationRoot = fs.mkdtempSync(path.join(storageRootState.path, 'generation-'));
  let database: Database.Database | null = null;
  try {
    assertExactDirectory(generationRoot, storageRootState.path);
    ensureIdentityMarker(generationRoot, options.identity, true);
    const roots = createGenerationRoots(generationRoot);
    database = (options.databaseOpener ?? openHostedDatabaseAtPath)(roots.databaseFile);
    let closed = false;
    return Object.freeze({
      database,
      roots,
      close(): void {
        if (closed) return;
        if (database?.open) database.close();
        removeGenerationRoot(generationRoot, storageRootState.path);
        closed = true;
      },
    });
  } catch (error) {
    if (database?.open) database.close();
    try {
      removeGenerationRoot(generationRoot, storageRootState.path);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'hosted runtime storage cleanup failed');
    }
    throw error;
  }
}

function removeGenerationRoot(generationRoot: string, storageRoot: string): void {
  if (!fs.existsSync(generationRoot)) return;
  const resolved = assertExactDirectory(generationRoot, storageRoot);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function createGenerationRoots(liveRoot: string): HostedRuntimeRoots {
  const roots = {
    liveRoot,
    databaseFile: path.join(liveRoot, 'app.sqlite'),
    projectsRoot: ensureChildDirectory(liveRoot, 'projects').path,
    artifactsRoot: ensureChildDirectory(liveRoot, 'artifacts').path,
    uploadsRoot: ensureChildDirectory(liveRoot, 'uploads').path,
    checkpointsRoot: ensureChildDirectory(liveRoot, 'checkpoints').path,
    sessionsRoot: ensureChildDirectory(liveRoot, 'sessions').path,
    runsRoot: ensureChildDirectory(liveRoot, 'runs').path,
    brokerRoot: ensureChildDirectory(liveRoot, 'broker').path,
  };
  return Object.freeze(roots);
}

function validateIdentity(identity: HostedStorageIdentity): void {
  const userKey = Buffer.from(identity.userKey, 'utf8');
  if (
    userKey.length < 1
    || userKey.length > 1_024
    || userKey.toString('utf8') !== identity.userKey
  ) {
    throw new Error('hosted storage user identity is invalid');
  }
  if (!/^od1_[0-9a-f]{64}$/u.test(identity.storageKey)) {
    throw new Error('hosted storage namespace is invalid');
  }
}

function prepareBaseDirectory(input: string): string {
  if (!path.isAbsolute(input)) throw new Error('hosted runtime root must be absolute');
  const missing: string[] = [];
  let current = path.resolve(input);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('hosted runtime root is unavailable');
    missing.unshift(path.basename(current));
    current = parent;
  }
  current = assertExactDirectory(current);
  for (const name of missing) current = ensureChildDirectory(current, name).path;
  return current;
}

function ensureChildDirectory(
  parent: string,
  name: string,
): { path: string; created: boolean } {
  if (name.length === 0 || name === '.' || name === '..' || /[\\/]/u.test(name)) {
    throw new Error('hosted runtime directory name is invalid');
  }
  const target = path.join(parent, name);
  let created = false;
  try {
    fs.mkdirSync(target);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return { path: assertExactDirectory(target, parent), created };
}

function assertExactDirectory(input: string, parent?: string): string {
  const expected = path.resolve(input);
  const info = fs.lstatSync(expected);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('hosted runtime path must be a real directory');
  }
  const resolved = fs.realpathSync(expected);
  if (!samePath(expected, resolved)) {
    throw new Error('hosted runtime path must not resolve through a link or reparse point');
  }
  if (parent != null && !isDirectChild(parent, resolved)) {
    throw new Error('hosted runtime path escapes its owning root');
  }
  return resolved;
}

function isDirectChild(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !relative.includes(path.sep);
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function ensureIdentityMarker(
  root: string,
  identity: HostedStorageIdentity,
  create: boolean,
): void {
  const markerPath = path.join(root, IDENTITY_MARKER);
  const expected: IdentityMarker = {
    derivationVersion: 1,
    userKey: identity.userKey,
    storageKey: identity.storageKey,
  };
  if (create) {
    fs.writeFileSync(markerPath, `${JSON.stringify(expected)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return;
  }

  let info: fs.Stats;
  try {
    info = fs.lstatSync(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('hosted runtime identity marker is missing');
    }
    throw error;
  }
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size > IDENTITY_MARKER_MAX_BYTES
    || !samePath(fs.realpathSync(markerPath), markerPath)
  ) {
    throw new Error('hosted runtime identity marker is invalid');
  }
  let marker: unknown;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    throw new Error('hosted runtime identity marker is invalid');
  }
  if (!sameMarker(marker, expected)) {
    throw new Error('hosted runtime identity marker does not match');
  }
}

function sameMarker(value: unknown, expected: IdentityMarker): boolean {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  return keys.length === 3
    && keys[0] === 'derivationVersion'
    && keys[1] === 'storageKey'
    && keys[2] === 'userKey'
    && marker.derivationVersion === expected.derivationVersion
    && marker.storageKey === expected.storageKey
    && marker.userKey === expected.userKey;
}
