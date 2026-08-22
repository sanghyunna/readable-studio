import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { openHostedDatabaseAtPath } from './db.js';
import {
  createHostedRuntimeStorage,
  type HostedRuntimeStorage,
  type HostedStorageIdentity,
} from './hosted-runtime-storage.js';

const SNAPSHOT_SCHEMA = 'readable-studio-hosted-snapshot';
const CHECKSUM_SCHEMA = 'readable-studio-hosted-snapshot-checksums';
const COMPLETION_SCHEMA = 'readable-studio-hosted-snapshot-complete';
const SNAPSHOT_VERSION = 1;
const SEQUENCE_WIDTH = 20;
const IMMUTABLE_METADATA_FILE_COUNT = 3;
const DEFAULT_LIMITS = Object.freeze({
  filesPerVersion: 20_000,
  bytesPerVersion: 1.5 * 1024 * 1024 * 1024,
  retainedBytesPerUser: 4 * 1024 * 1024 * 1024,
  retainedBytesGlobal: 64 * 1024 * 1024 * 1024,
});
const PAYLOAD_DIRECTORIES = [
  'projects',
  'artifacts',
  'uploads',
  'checkpoints',
  'sessions',
  'runs',
] as const;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_PARENT_DEPTH = 32;
const MAX_GLOBAL_QUOTA_WALK_ENTRIES = 1_000_000;
const publicationLocks = new Map<string, Promise<void>>();
const activePublicationStaging = new Set<string>();
const activeRestoreStaging = new Set<string>();

export type HostedSnapshotFailpoint =
  | 'after-session-copy'
  | 'after-database-backup'
  | 'after-payload-copy'
  | 'after-manifest-write'
  | 'before-completion-marker'
  | 'after-completion-marker'
  | 'after-version-rename'
  | 'after-latest-write'
  | 'after-retention-prune';

export type HostedSnapshotErrorCode =
  | 'HOSTED_CAPACITY_EXHAUSTED'
  | 'HOSTED_QUOTA_EXCEEDED'
  | 'HOSTED_RUNTIME_UNAVAILABLE';

export class HostedSnapshotError extends Error {
  readonly code: HostedSnapshotErrorCode;

  constructor(code: HostedSnapshotErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostedSnapshotError';
    this.code = code;
  }
}

class SnapshotValidationIoError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'SnapshotValidationIoError';
  }
}

export interface HostedSnapshotLimits {
  readonly filesPerVersion: number;
  readonly bytesPerVersion: number;
  readonly retainedBytesPerUser: number;
  readonly retainedBytesGlobal: number;
}

export interface HostedSnapshotStoreOptions {
  readonly runtimeRoot: string;
  readonly identity: HostedStorageIdentity;
  readonly limits?: Partial<HostedSnapshotLimits>;
  readonly failpoint?: (name: HostedSnapshotFailpoint) => void | Promise<void>;
  /** Test seam for proving Windows case-alias lock identity on every platform. */
  readonly publicationLockIdentity?: {
    readonly canonicalPath: string;
    readonly platform: NodeJS.Platform;
  };
}

export interface HostedSnapshotPublication {
  readonly sequence: string;
  readonly versionRoot: string;
  readonly bytes: number;
  readonly fileCount: number;
}

export interface HostedSnapshotRestore {
  readonly sequence: string;
  readonly storage: HostedRuntimeStorage;
}

export interface HostedSnapshotStore {
  publish(input: {
    readonly storage: HostedRuntimeStorage;
    readonly quiesce: () => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<HostedSnapshotPublication>;
  restore(): Promise<HostedSnapshotRestore | null>;
}

interface SnapshotFileChecksum {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface SnapshotChecksums {
  readonly schema: typeof CHECKSUM_SCHEMA;
  readonly version: typeof SNAPSHOT_VERSION;
  readonly sequence: string;
  readonly directories: readonly string[];
  readonly files: readonly SnapshotFileChecksum[];
}

interface SnapshotManifest {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly version: typeof SNAPSHOT_VERSION;
  readonly derivationVersion: 1;
  readonly sequence: string;
  readonly userKey: string;
  readonly storageKey: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly checksumsSha256: string;
}

interface SnapshotCompletion {
  readonly schema: typeof COMPLETION_SCHEMA;
  readonly version: typeof SNAPSHOT_VERSION;
  readonly sequence: string;
  readonly manifestSha256: string;
  readonly checksumsSha256: string;
}

interface ValidSnapshot {
  readonly sequence: string;
  readonly root: string;
  readonly manifest: SnapshotManifest;
  readonly files: readonly SnapshotFileChecksum[];
  readonly bytesOnDisk: number;
}

interface CaptureBudget {
  readonly limits: HostedSnapshotLimits;
  readonly directories: Set<string>;
  bytes: number;
  files: number;
}

export function createHostedSnapshotStore(
  options: HostedSnapshotStoreOptions,
): HostedSnapshotStore {
  validateIdentity(options.identity);
  const runtimeRoot = prepareBaseDirectory(options.runtimeRoot);
  const limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
  const snapshotRoot = prepareSnapshotRoot(runtimeRoot, options.identity);
  const versionsRoot = assertDirectory(path.join(snapshotRoot, 'versions'), snapshotRoot);
  scavengeRestoreStaging(runtimeRoot, options.identity);
  const publicationLockKey = canonicalPublicationLockKey(
    options.publicationLockIdentity?.canonicalPath ?? snapshotRoot,
    options.publicationLockIdentity?.platform ?? process.platform,
  );
  const globalPublicationLockKey = `global:${canonicalPublicationLockKey(
    path.join(runtimeRoot, 'snapshots'),
    options.publicationLockIdentity?.platform ?? process.platform,
  )}`;

  function publish(input: {
    readonly storage: HostedRuntimeStorage;
    readonly quiesce: () => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<HostedSnapshotPublication> {
    return withPublicationLock(publicationLockKey, () => publishSnapshot({
        ...(options.failpoint ? { failpoint: options.failpoint } : {}),
        identity: options.identity,
        input,
        limits,
        globalPublicationLockKey,
        runtimeRoot,
        snapshotRoot,
        versionsRoot,
      }));
  }

  async function restore(): Promise<HostedSnapshotRestore | null> {
    await publicationLocks.get(publicationLockKey);
    await scavengeRetiredVersions(versionsRoot);
    let sequences = listVersionSequences(versionsRoot);
    if (sequences.length > 2) {
      await withPublicationLock(globalPublicationLockKey, async () => {
        await pruneRetainedVersions(runtimeRoot, options.identity, limits);
        sequences = listVersionSequences(versionsRoot);
        const newest = sequences.at(-1);
        if (newest != null) {
          try { writeLatestHint(snapshotRoot, newest); } catch { /* non-authoritative hint */ }
        }
      });
    }
    for (const sequence of sequences.reverse()) {
      const versionRoot = path.join(versionsRoot, sequence);
      let snapshot: ValidSnapshot;
      try {
        snapshot = await validateSnapshot(versionRoot, options.identity, sequence, limits);
      } catch (error) {
        if (isTransientSnapshotValidationError(error)) {
          throw new HostedSnapshotError(
            'HOSTED_RUNTIME_UNAVAILABLE',
            error instanceof Error
              ? error.message
              : 'hosted snapshot validation I/O failed',
            error,
          );
        }
        // Scan order is authoritative; a corrupt newer version falls back.
        continue;
      }
      const stagedPayload = await stageSnapshotPayload(
        snapshot,
        runtimeRoot,
        options.identity,
        limits,
      );
      let storage: HostedRuntimeStorage | null = null;
      try {
        storage = createHostedRuntimeStorage({
          identity: options.identity,
          runtimeRoot,
          databaseOpener(databaseFile) {
            installStagedPayload(stagedPayload, path.dirname(databaseFile));
            return openRestoredDatabase(databaseFile);
          },
        });
        await relocateRestoredSessions(storage.database, storage.roots.liveRoot);
        verifyDatabase(storage.database);
        storage.database.pragma('wal_checkpoint(TRUNCATE)');
        await syncFileAsync(storage.roots.databaseFile);
        await removeRestoreStaging(stagedPayload, runtimeRoot);
        return { sequence, storage };
      } catch (error) {
        const failures: unknown[] = [error];
        if (storage != null) {
          try {
            storage.close();
          } catch (closeError) {
            failures.push(closeError);
          }
        }
        try {
          await removeRestoreStaging(stagedPayload, runtimeRoot);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        throw new HostedSnapshotError(
          'HOSTED_RUNTIME_UNAVAILABLE',
          failures.length === 1 && error instanceof Error
            ? error.message
            : 'hosted snapshot restoration cleanup failed',
          failures.length === 1 ? error : new AggregateError(failures),
        );
      }
    }
    if (sequences.length > 0) {
      throw new HostedSnapshotError(
        'HOSTED_RUNTIME_UNAVAILABLE',
        'hosted snapshot history contains no valid restorable version',
      );
    }
    return null;
  }

  return Object.freeze({ publish, restore });
}

function canonicalPublicationLockKey(
  canonicalPath: string,
  platform: NodeJS.Platform,
): string {
  const normalized = path.normalize(canonicalPath);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function snapshotQuota(message: string): never {
  throw new HostedSnapshotError('HOSTED_QUOTA_EXCEEDED', message);
}

function snapshotCapacity(message: string): never {
  throw new HostedSnapshotError('HOSTED_CAPACITY_EXHAUSTED', message);
}

async function publishSnapshot(options: {
  readonly runtimeRoot: string;
  readonly snapshotRoot: string;
  readonly versionsRoot: string;
  readonly identity: HostedStorageIdentity;
  readonly limits: HostedSnapshotLimits;
  readonly globalPublicationLockKey: string;
  readonly failpoint?: (name: HostedSnapshotFailpoint) => void | Promise<void>;
  readonly input: {
    readonly storage: HostedRuntimeStorage;
    readonly quiesce: () => Promise<void>;
    readonly signal?: AbortSignal;
  };
}): Promise<HostedSnapshotPublication> {
  const signal = options.input.signal;
  throwIfPublicationAborted(signal);
  assertOwnedLiveStorage(options.input.storage, options.runtimeRoot, options.identity);
  await publicationPhase(signal, options.input.quiesce);
  assertOwnedLiveStorage(options.input.storage, options.runtimeRoot, options.identity);
  throwIfPublicationAborted(signal);

  const sequence = nextSequence(options.snapshotRoot, options.versionsRoot);
  await publicationPhase(signal, () => removeStaleStaging(options.snapshotRoot));
  const stagingRoot = fs.mkdtempSync(
    path.join(options.snapshotRoot, `.staging-${sequence}-`),
  );
  throwIfPublicationAborted(signal);
  activePublicationStaging.add(stagingRoot);
  const payloadRoot = path.join(stagingRoot, 'payload');
  fs.mkdirSync(payloadRoot);
  const captureBudget = createCaptureBudget(options.limits);
  let completedRoot: string | null = null;
  let pendingRoot: string | null = null;
  let previousAuthoritySequence: string | null | undefined;
  try {
    for (const name of PAYLOAD_DIRECTORIES) {
      fs.mkdirSync(path.join(payloadRoot, name));
      reserveCapturedDirectory(captureBudget, name);
    }
    const stagedDatabase = path.join(payloadRoot, 'app.sqlite');
    ensureCapturedFileCapacity(captureBudget);
    const databasePageSize = databasePragmaInteger(
      options.input.storage.database,
      'page_size',
    );
    ensureDatabaseBackupFits(
      options.input.storage.database,
      captureBudget,
      databasePageSize,
    );
    await publicationPhase(signal, () => options.input.storage.database.backup(stagedDatabase, {
      progress({ totalPages }) {
        throwIfPublicationAborted(signal);
        ensureProjectedBytesFit(captureBudget, totalPages * databasePageSize);
        return 256;
      },
    }));
    reserveCapturedFile(captureBudget, fs.lstatSync(stagedDatabase).size);
    await publicationPhase(signal, () => copyReachableSessions(
      stagedDatabase,
      options.input.storage.roots.liveRoot,
      payloadRoot,
      captureBudget,
    ));
    await publicationPhase(signal, () => fire(options.failpoint, 'after-session-copy'));
    await publicationPhase(signal, () => normalizeStagedSessions(
      stagedDatabase,
      options.input.storage.roots.liveRoot,
      payloadRoot,
    ));
    await publicationPhase(signal, () => syncFileAsync(stagedDatabase));
    await publicationPhase(signal, () => fire(options.failpoint, 'after-database-backup'));

    const sourceRoots = {
      projects: options.input.storage.roots.projectsRoot,
      artifacts: options.input.storage.roots.artifactsRoot,
      uploads: options.input.storage.roots.uploadsRoot,
      checkpoints: options.input.storage.roots.checkpointsRoot,
      runs: options.input.storage.roots.runsRoot,
    } as const;
    for (const [name, source] of Object.entries(sourceRoots)) {
      await publicationPhase(signal, () => copyTreeExact(
        source,
        path.join(payloadRoot, name),
        captureBudget,
        name,
      ));
    }
    await publicationPhase(signal, () => fire(options.failpoint, 'after-payload-copy'));

    const inventory = await publicationPhase(
      signal,
      () => inventoryTreeExact(payloadRoot, options.limits),
    );
    const directories = inventory.directories;
    const files = await publicationPhase(
      signal,
      () => checksumPayload(payloadRoot, inventory.files, options.limits),
    );
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const checksums: SnapshotChecksums = {
      directories,
      files,
      schema: CHECKSUM_SCHEMA,
      sequence,
      version: SNAPSHOT_VERSION,
    };
    const checksumsText = `${JSON.stringify(checksums)}\n`;
    const checksumsSha256 = sha256(checksumsText);
    const manifest: SnapshotManifest = {
      checksumsSha256,
      derivationVersion: 1,
      fileCount: files.length,
      schema: SNAPSHOT_SCHEMA,
      sequence,
      storageKey: options.identity.storageKey,
      totalBytes,
      userKey: options.identity.userKey,
      version: SNAPSHOT_VERSION,
    };
    const manifestText = `${JSON.stringify(manifest)}\n`;
    const completion: SnapshotCompletion = {
      checksumsSha256,
      manifestSha256: sha256(manifestText),
      schema: COMPLETION_SCHEMA,
      sequence,
      version: SNAPSHOT_VERSION,
    };
    const completionText = `${JSON.stringify(completion)}\n`;
    const immutableBytes = totalBytes
      + Buffer.byteLength(checksumsText)
      + Buffer.byteLength(manifestText)
      + Buffer.byteLength(completionText);
    if (immutableBytes > options.limits.bytesPerVersion) {
      snapshotQuota('hosted snapshot version byte quota exceeded');
    }
    throwIfPublicationAborted(signal);
    writeDurable(path.join(stagingRoot, 'checksums.json'), checksumsText);
    writeDurable(path.join(stagingRoot, 'manifest.json'), manifestText);
    throwIfPublicationAborted(signal);
    await publicationPhase(signal, () => fire(options.failpoint, 'after-manifest-write'));

    return await withPublicationLock(
      options.globalPublicationLockKey,
      async () => {
      await publicationPhase(signal, () => preflightRetention({
        completionBytes: Buffer.byteLength(completionText),
        identity: options.identity,
        limits: options.limits,
        runtimeRoot: options.runtimeRoot,
        sequence,
        snapshotRoot: options.snapshotRoot,
        stagingRoot,
        versionsRoot: options.versionsRoot,
      }));
      previousAuthoritySequence = listVersionSequences(options.versionsRoot).at(-1) ?? null;
      await publicationPhase(signal, () => fire(options.failpoint, 'before-completion-marker'));
      throwIfPublicationAborted(signal);
      writeDurable(path.join(stagingRoot, '.complete.json'), completionText);
      throwIfPublicationAborted(signal);
      await publicationPhase(signal, () => fire(options.failpoint, 'after-completion-marker'));
      const validated = await publicationPhase(signal, () => validateSnapshot(
        stagingRoot,
        options.identity,
        sequence,
        options.limits,
      ));

      const versionRoot = path.join(options.versionsRoot, sequence);
      throwIfPublicationAborted(signal);
      const publication = {
        bytes: validated.bytesOnDisk,
        fileCount: files.length,
        sequence,
        versionRoot,
      };
      if (signal != null) {
        pendingRoot = path.join(
          options.versionsRoot,
          `.retired-pending-${sequence}-${randomUUID()}`,
        );
        fs.renameSync(stagingRoot, pendingRoot);
        await publicationPhase(signal, () => fire(options.failpoint, 'after-version-rename'));
        let maintenanceError: unknown;
        try {
          await repairPublishedSnapshot(options, sequence, true, signal);
        } catch (error) {
          if (signal.aborted) throw publicationAborted(signal);
          maintenanceError = error;
        }
        if (maintenanceError != null) {
          try {
            await repairPublishedSnapshot(options, sequence, false, signal);
          } catch (error) {
            if (signal.aborted) throw publicationAborted(signal);
            // The latest hint is non-authoritative. A later restore/publish
            // repairs maintenance after the candidate is committed below.
          }
        }
        throwIfPublicationAborted(signal);
        fs.renameSync(pendingRoot, versionRoot);
        pendingRoot = null;
        completedRoot = versionRoot;
        try { writeLatestHint(options.snapshotRoot, sequence); } catch { /* cache hint */ }
        return publication;
      }

      fs.renameSync(stagingRoot, versionRoot);
      completedRoot = versionRoot;
      let maintenanceError: unknown;
      try {
        await publicationPhase(signal, () => fire(options.failpoint, 'after-version-rename'));
        await repairPublishedSnapshot(options, sequence, true, signal);
      } catch (error) {
        maintenanceError = error;
      }
      if (maintenanceError != null) {
        try {
          await repairPublishedSnapshot(options, sequence, false);
        } catch {
          // The rename above is the commit point. Restore scans completed
          // versions directly, so maintenance is retried by the next
          // publish/restore without making committed work appear to fail.
        }
      }
      return publication;
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (pendingRoot != null) {
      try {
        await removeExactDirectory(pendingRoot, options.versionsRoot);
        pendingRoot = null;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    } else if (completedRoot == null) {
      try {
        await removeExactDirectory(stagingRoot, options.snapshotRoot);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (signal?.aborted && previousAuthoritySequence !== undefined) {
      restoreLatestAfterAbort(options.snapshotRoot, previousAuthoritySequence);
    }
    if (cleanupErrors.length > 0) {
      throw new HostedSnapshotError(
        'HOSTED_RUNTIME_UNAVAILABLE',
        'hosted snapshot abort cleanup failed',
        new AggregateError([error, ...cleanupErrors]),
      );
    }
    throw error;
  } finally {
    activePublicationStaging.delete(stagingRoot);
  }
}

async function repairPublishedSnapshot(
  options: {
    readonly failpoint?: (name: HostedSnapshotFailpoint) => void | Promise<void>;
    readonly identity: HostedStorageIdentity;
    readonly limits: HostedSnapshotLimits;
    readonly runtimeRoot: string;
    readonly snapshotRoot: string;
  },
  sequence: string,
  fireFailpoints: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const failures: unknown[] = [];
  throwIfPublicationAborted(signal);
  try {
    writeLatestHint(options.snapshotRoot, sequence);
  } catch (error) {
    failures.push(error);
  }
  throwIfPublicationAborted(signal);
  if (fireFailpoints) {
    try {
      await publicationPhase(signal, () => fire(options.failpoint, 'after-latest-write'));
    } catch (error) {
      if (signal?.aborted) throw publicationAborted(signal);
      failures.push(error);
    }
  }
  try {
    await publicationPhase(
      signal,
      () => pruneRetainedVersions(options.runtimeRoot, options.identity, options.limits),
    );
  } catch (error) {
    if (signal?.aborted) throw publicationAborted(signal);
    failures.push(error);
  }
  if (fireFailpoints) {
    try {
      await publicationPhase(signal, () => fire(options.failpoint, 'after-retention-prune'));
    } catch (error) {
      if (signal?.aborted) throw publicationAborted(signal);
      failures.push(error);
    }
  }
  throwIfPublicationAborted(signal);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'hosted snapshot maintenance failed');
}

async function publicationPhase<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  throwIfPublicationAborted(signal);
  try {
    const result = await work();
    throwIfPublicationAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) throw publicationAborted(signal);
    throw error;
  }
}

function throwIfPublicationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw publicationAborted(signal);
}

function publicationAborted(signal: AbortSignal): HostedSnapshotError {
  return new HostedSnapshotError(
    'HOSTED_RUNTIME_UNAVAILABLE',
    'hosted snapshot publication was aborted before becoming authoritative',
    signal.reason,
  );
}

function restoreLatestAfterAbort(
  snapshotRoot: string,
  previousSequence: string | null,
): void {
  const latest = path.join(snapshotRoot, 'latest');
  if (fs.existsSync(latest)) {
    try {
      const info = fs.lstatSync(latest);
      if (
        !info.isFile()
        || info.isSymbolicLink()
        || !samePath(fs.realpathSync(latest), latest)
      ) return;
    } catch {
      return;
    }
  }
  try {
    if (previousSequence != null) writeLatestHint(snapshotRoot, previousSequence);
    else fs.rmSync(latest, { force: true });
  } catch {
    // latest is a non-authoritative cache hint; restore scans valid versions.
  }
}

async function withPublicationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = publicationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  publicationLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (publicationLocks.get(key) === current) publicationLocks.delete(key);
  }
}

async function removeStaleStaging(snapshotRoot: string): Promise<void> {
  for (const entry of await fsp.readdir(snapshotRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.staging-\d{20}-/u.test(entry.name)) {
      await removeExactDirectory(path.join(snapshotRoot, entry.name), snapshotRoot);
    }
  }
}

function prepareSnapshotRoot(
  runtimeRoot: string,
  identity: HostedStorageIdentity,
): string {
  const snapshotsRoot = ensureDirectory(runtimeRoot, 'snapshots');
  const storageState = ensureDirectoryState(snapshotsRoot, identity.storageKey);
  ensureIdentityMarker(storageState.path, identity, storageState.created);
  ensureDirectory(storageState.path, 'versions');
  return storageState.path;
}

function scavengeRestoreStaging(
  runtimeRoot: string,
  identity: HostedStorageIdentity,
): void {
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('.restore-')) continue;
    const candidate = path.join(runtimeRoot, entry.name);
    if ([...activeRestoreStaging].some((active) => samePath(active, candidate))) continue;
    const info = fs.lstatSync(candidate);
    if (
      !info.isDirectory()
      || info.isSymbolicLink()
      || !samePath(fs.realpathSync(candidate), candidate)
    ) {
      throw new Error('hosted snapshot restore staging path is invalid');
    }
    const ownedMatch = /^\.restore-(od1_[0-9a-f]{64})-/u.exec(entry.name);
    if (ownedMatch != null && ownedMatch[1] !== identity.storageKey) continue;
    const exact = assertDirectory(candidate, runtimeRoot);
    fs.rmSync(exact, { force: true, recursive: true });
  }
}

function ensureDirectory(parent: string, name: string): string {
  return ensureDirectoryState(parent, name).path;
}

function ensureDirectoryState(parent: string, name: string): { path: string; created: boolean } {
  if (!name || name === '.' || name === '..' || /[\\/]/u.test(name)) {
    throw new Error('hosted snapshot directory name is invalid');
  }
  const target = path.join(parent, name);
  let created = false;
  try {
    fs.mkdirSync(target);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return { created, path: assertDirectory(target, parent) };
}

function validateIdentity(identity: HostedStorageIdentity): void {
  const userKey = Buffer.from(identity.userKey, 'utf8');
  if (userKey.length < 1 || userKey.length > 1_024 || userKey.toString('utf8') !== identity.userKey) {
    throw new Error('hosted snapshot user identity is invalid');
  }
  if (!/^od1_[0-9a-f]{64}$/u.test(identity.storageKey)) {
    throw new Error('hosted snapshot storage namespace is invalid');
  }
}

function validateLimits(limits: HostedSnapshotLimits): HostedSnapshotLimits {
  for (const [name, maximum] of Object.entries(DEFAULT_LIMITS)) {
    const value = limits[name as keyof HostedSnapshotLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`hosted snapshot ${name} exceeds its fixed maximum`);
    }
  }
  if (limits.retainedBytesGlobal < limits.retainedBytesPerUser) {
    throw new Error('hosted snapshot global quota must cover one user quota');
  }
  return Object.freeze(limits);
}

function ensureIdentityMarker(
  root: string,
  identity: HostedStorageIdentity,
  create: boolean,
): void {
  const file = path.join(root, '.identity.json');
  const expected = {
    derivationVersion: 1,
    storageKey: identity.storageKey,
    userKey: identity.userKey,
  } as const;
  if (create) {
    writeDurable(file, `${JSON.stringify(expected)}\n`, 'wx');
    return;
  }
  const value = readStrictJson(file, 4 * 1024);
  assertExactKeys(value, ['derivationVersion', 'storageKey', 'userKey']);
  if (
    value.derivationVersion !== 1
    || value.storageKey !== identity.storageKey
    || value.userKey !== identity.userKey
  ) {
    throw new Error('hosted snapshot identity marker does not match');
  }
}

function assertOwnedLiveStorage(
  storage: HostedRuntimeStorage,
  runtimeRoot: string,
  identity: HostedStorageIdentity,
): void {
  if (!storage.database.open) throw new Error('hosted snapshot source database is closed');
  const expectedStorageRoot = path.join(runtimeRoot, 'live', identity.storageKey);
  const liveRoot = assertDirectory(storage.roots.liveRoot, expectedStorageRoot);
  if (!path.basename(liveRoot).startsWith('generation-')) {
    throw new Error('hosted snapshot source generation is invalid');
  }
  ensureIdentityMarker(liveRoot, identity, false);
  for (const [name, root] of Object.entries({
    artifacts: storage.roots.artifactsRoot,
    checkpoints: storage.roots.checkpointsRoot,
    projects: storage.roots.projectsRoot,
    runs: storage.roots.runsRoot,
    sessions: storage.roots.sessionsRoot,
    uploads: storage.roots.uploadsRoot,
  })) {
    if (assertDirectory(root, liveRoot) !== path.join(liveRoot, name)) {
      throw new Error('hosted snapshot source roots do not match');
    }
  }
  if (!samePath(path.resolve(storage.roots.databaseFile), path.join(liveRoot, 'app.sqlite'))) {
    throw new Error('hosted snapshot source database path does not match');
  }
}

function nextSequence(snapshotRoot: string, versionsRoot: string): string {
  let maximum = 0n;
  for (const name of fs.readdirSync(versionsRoot)) {
    if (/^\d{20}$/u.test(name)) maximum = maxBigInt(maximum, BigInt(name));
  }
  for (const name of fs.readdirSync(snapshotRoot)) {
    const match = /^\.staging-(\d{20})-/u.exec(name);
    if (match?.[1]) maximum = maxBigInt(maximum, BigInt(match[1]));
  }
  const next = maximum + 1n;
  const sequence = next.toString().padStart(SEQUENCE_WIDTH, '0');
  if (sequence.length !== SEQUENCE_WIDTH) throw new Error('hosted snapshot sequence exhausted');
  return sequence;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function createCaptureBudget(limits: HostedSnapshotLimits): CaptureBudget {
  return { bytes: 0, directories: new Set(), files: 0, limits };
}

function reserveCapturedDirectory(budget: CaptureBudget, relative: string): void {
  if (budget.directories.has(relative)) return;
  budget.directories.add(relative);
  if (budget.directories.size > budget.limits.filesPerVersion) {
    snapshotQuota('hosted snapshot directory quota exceeded');
  }
}

function reserveCapturedFile(budget: CaptureBudget, bytes: number): void {
  ensureCapturedFileCapacity(budget);
  budget.files += 1;
  budget.bytes += bytes;
  if (budget.bytes > budget.limits.bytesPerVersion) {
    snapshotQuota('hosted snapshot byte quota exceeded');
  }
}

function ensureCapturedFileCapacity(budget: CaptureBudget): void {
  if (
    budget.files + 1 + IMMUTABLE_METADATA_FILE_COUNT
    > budget.limits.filesPerVersion
  ) {
    snapshotQuota('hosted snapshot file quota exceeded');
  }
}

function databasePragmaInteger(
  database: Database.Database,
  pragma: 'page_count' | 'page_size',
): number {
  const value = database.pragma(pragma, { simple: true });
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`hosted snapshot database ${pragma} is invalid`);
  }
  return value as number;
}

function ensureDatabaseBackupFits(
  database: Database.Database,
  budget: CaptureBudget,
  pageSize: number,
): void {
  ensureProjectedBytesFit(
    budget,
    databasePragmaInteger(database, 'page_count') * pageSize,
  );
}

function ensureProjectedBytesFit(budget: CaptureBudget, projectedBytes: number): void {
  if (
    !Number.isSafeInteger(projectedBytes)
    || projectedBytes < 0
    || budget.bytes + projectedBytes > budget.limits.bytesPerVersion
  ) {
    snapshotQuota('hosted snapshot byte quota exceeded');
  }
}

async function copyTreeExact(
  sourceRoot: string,
  targetRoot: string,
  budget: CaptureBudget,
  targetPrefix: string,
): Promise<void> {
  const source = assertDirectory(sourceRoot);
  const target = assertDirectory(targetRoot);
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const before = await fsp.lstat(sourcePath);
    if (
      before.isSymbolicLink()
      || !await isExactRealChild(source, entry.name)
    ) {
      throw new Error('hosted snapshot source contains a link or reparse point');
    }
    const relative = targetPrefix ? `${targetPrefix}/${entry.name}` : entry.name;
    if (before.isDirectory()) {
      reserveCapturedDirectory(budget, relative);
      await fsp.mkdir(targetPath);
      await copyTreeExact(sourcePath, targetPath, budget, relative);
      continue;
    }
    if (!before.isFile()) throw new Error('hosted snapshot source contains a special file');
    reserveCapturedFile(budget, before.size);
    await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    await syncFileAsync(targetPath);
    const after = await fsp.lstat(sourcePath);
    if (!sameFileState(before, after)) {
      throw new Error('hosted snapshot source changed during capture');
    }
  }
}

function sameFileState(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function copyReachableSessions(
  databaseFile: string,
  liveRoot: string,
  payloadRoot: string,
  budget: CaptureBudget,
): Promise<void> {
  const database = new Database(databaseFile, { fileMustExist: true, readonly: true });
  try {
    const rows = database.prepare(
      `SELECT s.session_id AS sessionId, c.project_id AS projectId
         FROM agent_sessions s
         JOIN conversations c ON c.id = s.conversation_id`,
    ).all() as Array<{ projectId: string; sessionId: string }>;
    const copied = new Map<string, string>();
    for (const row of rows) {
      const logical = logicalSessionPath(row.sessionId, liveRoot);
      await copyReachableSessionLineage(
        logical,
        liveRoot,
        payloadRoot,
        `projects/${row.projectId}`,
        copied,
        new Set(),
        budget,
        0,
      );
    }
  } finally {
    database.close();
  }
}

async function copyReachableSessionLineage(
  logicalPath: string,
  liveRoot: string,
  payloadRoot: string,
  expectedCwd: string,
  copied: Map<string, string>,
  active: Set<string>,
  budget: CaptureBudget,
  depth: number,
): Promise<void> {
  const copiedCwd = copied.get(logicalPath);
  if (copiedCwd != null) {
    if (copiedCwd !== expectedCwd) {
      throw new Error('hosted snapshot session is referenced by multiple projects');
    }
    return;
  }
  if (depth >= MAX_SESSION_PARENT_DEPTH) throw new Error('hosted snapshot session chain is too deep');
  if (active.has(logicalPath)) throw new Error('hosted snapshot session chain contains a cycle');
  active.add(logicalPath);
  const source = containedFile(liveRoot, logicalPath);
  const before = await fsp.lstat(source);
  const { header } = await readSessionFileAsync(source);
  const cwd = logicalLivePath(header.cwd, liveRoot);
  if (cwd !== expectedCwd) {
    throw new Error('hosted snapshot session cwd does not match its owning project');
  }
  if (typeof header.parentSession === 'string') {
    const parentAbsolute = path.isAbsolute(header.parentSession)
      ? header.parentSession
      : path.resolve(path.dirname(path.join(liveRoot, logicalPath)), header.parentSession);
    const parent = logicalLivePath(parentAbsolute, liveRoot);
    if (!parent.startsWith('sessions/')) {
      throw new Error('hosted snapshot session parent is outside the session root');
    }
    await copyReachableSessionLineage(
      parent,
      liveRoot,
      payloadRoot,
      expectedCwd,
      copied,
      active,
      budget,
      depth + 1,
    );
  }
  const target = containedTarget(payloadRoot, logicalPath);
  await ensureCapturedParents(payloadRoot, path.posix.dirname(logicalPath), budget);
  reserveCapturedFile(budget, before.size);
  await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  await syncFileAsync(target);
  const after = await fsp.lstat(source);
  if (!sameFileState(before, after)) {
    throw new Error('hosted snapshot source changed during capture');
  }
  active.delete(logicalPath);
  copied.set(logicalPath, expectedCwd);
}

async function ensureCapturedParents(
  root: string,
  relativeDirectory: string,
  budget: CaptureBudget,
): Promise<void> {
  if (relativeDirectory === '.') return;
  let current = '';
  for (const part of relativeDirectory.split('/')) {
    current = current ? `${current}/${part}` : part;
    if (budget.directories.has(current)) continue;
    reserveCapturedDirectory(budget, current);
    try {
      await fsp.mkdir(containedTarget(root, current));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      containedDirectory(root, current);
    }
  }
}

async function normalizeStagedSessions(
  databaseFile: string,
  liveRoot: string,
  payloadRoot: string,
): Promise<void> {
  const database = new Database(databaseFile);
  try {
    const rows = database.prepare(
      `SELECT s.conversation_id AS conversationId, s.agent_id AS agentId,
              s.session_id AS sessionId, c.project_id AS projectId
         FROM agent_sessions s
         JOIN conversations c ON c.id = s.conversation_id`,
    ).all() as Array<{
      conversationId: string;
      agentId: string;
      projectId: string;
      sessionId: string;
    }>;
    const normalized = new Map<string, string>();
    const active = new Set<string>();
    const update = database.prepare(
      'UPDATE agent_sessions SET session_id = ? WHERE conversation_id = ? AND agent_id = ?',
    );
    const updates: Array<{ logical: string; conversationId: string; agentId: string }> = [];
    for (const row of rows) {
      const logical = logicalSessionPath(row.sessionId, liveRoot);
      await normalizeSessionLineage(
        logical,
        liveRoot,
        payloadRoot,
        `projects/${row.projectId}`,
        normalized,
        active,
        0,
      );
      updates.push({ agentId: row.agentId, conversationId: row.conversationId, logical });
    }
    const transaction = database.transaction(() => {
      for (const row of updates) {
        update.run(row.logical, row.conversationId, row.agentId);
      }
    });
    transaction();
    verifyDatabase(database);
  } finally {
    database.close();
  }
}

async function normalizeSessionLineage(
  logicalPath: string,
  liveRoot: string,
  payloadRoot: string,
  expectedCwd: string,
  normalized: Map<string, string>,
  active: Set<string>,
  depth: number,
): Promise<void> {
  const normalizedCwd = normalized.get(logicalPath);
  if (normalizedCwd != null) {
    if (normalizedCwd !== expectedCwd) {
      throw new Error('hosted snapshot session is referenced by multiple projects');
    }
    return;
  }
  if (depth >= MAX_SESSION_PARENT_DEPTH) throw new Error('hosted snapshot session chain is too deep');
  if (active.has(logicalPath)) throw new Error('hosted snapshot session chain contains a cycle');
  active.add(logicalPath);
  const file = containedFile(payloadRoot, logicalPath);
  const session = await readSessionFileAsync(file);
  const { header } = session;
  header.cwd = logicalLivePath(header.cwd, liveRoot);
  if (header.cwd !== expectedCwd) {
    throw new Error('hosted snapshot session cwd does not match its owning project');
  }
  if (typeof header.parentSession === 'string') {
    const parentAbsolute = path.isAbsolute(header.parentSession)
      ? header.parentSession
      : path.resolve(path.dirname(path.join(liveRoot, logicalPath)), header.parentSession);
    const parent = logicalLivePath(parentAbsolute, liveRoot);
    if (!parent.startsWith('sessions/')) {
      throw new Error('hosted snapshot session parent is outside the session root');
    }
    header.parentSession = parent;
    await normalizeSessionLineage(
      parent,
      liveRoot,
      payloadRoot,
      expectedCwd,
      normalized,
      active,
      depth + 1,
    );
  }
  await rewriteSessionHeaderAsync(file, session, header);
  active.delete(logicalPath);
  normalized.set(logicalPath, expectedCwd);
}

interface SessionHeaderRead {
  readonly bodyOffset: number;
  readonly header: Record<string, unknown> & { cwd: string; parentSession?: string };
  readonly headerTerminated: boolean;
  readonly size: number;
}

async function readSessionFileAsync(file: string): Promise<SessionHeaderRead> {
  const info = await fsp.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_SESSION_FILE_BYTES) {
    throw new Error('hosted snapshot session file is invalid');
  }
  const handle = await fsp.open(file, 'r');
  try {
    const prefix = Buffer.alloc(Math.min(info.size, MAX_SESSION_HEADER_BYTES + 1));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const session = parseSessionHeader(prefix.subarray(0, bytesRead), info.size);
    await validateSessionBody(handle, session.bodyOffset, session.size);
    return session;
  } catch (error) {
    if (isTransientSnapshotValidationError(error)) throw error;
    throw new Error('hosted snapshot session JSONL is invalid');
  } finally {
    await handle.close();
  }
}

function parseSessionHeader(prefix: Buffer, size: number): SessionHeaderRead {
  const newline = prefix.indexOf(0x0A);
  const headerTerminated = newline >= 0;
  const headerBytes = headerTerminated ? prefix.subarray(0, newline) : prefix;
  if ((!headerTerminated && size > prefix.length) || headerBytes.length > MAX_SESSION_HEADER_BYTES) {
    throw new Error('hosted snapshot session header is too large');
  }
  let header: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(headerBytes).replace(/\r$/u, '');
    header = JSON.parse(text) as unknown;
  } catch {
    throw new Error('hosted snapshot session JSONL is invalid');
  }
  const record = header as Record<string, unknown>;
  if (
    header == null
    || typeof header !== 'object'
    || Array.isArray(header)
    || record.type !== 'session'
    || typeof record.cwd !== 'string'
    || (record.parentSession !== undefined && typeof record.parentSession !== 'string')
  ) {
    throw new Error('hosted snapshot session header is invalid');
  }
  return {
    bodyOffset: headerTerminated ? newline + 1 : size,
    header: record as SessionHeaderRead['header'],
    headerTerminated,
    size,
  };
}

async function validateSessionBody(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  bodyOffset: number,
  size: number,
): Promise<void> {
  if (bodyOffset >= size) return;
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let position = bodyOffset;
  while (position < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (bytesRead < 1) throw new Error('hosted snapshot session body ended early');
    position += bytesRead;
    pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: position < size });
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      validateSessionRecord(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }
  if (pending.length > 0) validateSessionRecord(pending);
}

function validateSessionRecord(line: string): void {
  if (!line) throw new Error('hosted snapshot session JSONL is invalid');
  let record: unknown;
  try {
    record = JSON.parse(line.replace(/\r$/u, '')) as unknown;
  } catch {
    throw new Error('hosted snapshot session JSONL is invalid');
  }
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('hosted snapshot session JSONL is invalid');
  }
}

async function rewriteSessionHeaderAsync(
  file: string,
  session: SessionHeaderRead,
  header: SessionHeaderRead['header'],
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const source = await fsp.open(file, 'r');
    try {
      const target = await fsp.open(temporary, 'wx', 0o600);
      try {
        await target.writeFile(
          `${JSON.stringify(header)}${session.headerTerminated ? '\n' : ''}`,
          'utf8',
        );
        const buffer = Buffer.alloc(64 * 1024);
        let position = session.bodyOffset;
        while (position < session.size) {
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, session.size - position),
            position,
          );
          if (bytesRead < 1) throw new Error('hosted snapshot session body ended early');
          await writeAllAsync(target, buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        await target.sync();
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

async function writeAllAsync(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  buffer: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten < 1) throw new Error('hosted snapshot session write ended early');
    offset += bytesWritten;
  }
}

function logicalLivePath(input: string, liveRoot: string): string {
  const absolute = path.isAbsolute(input) ? path.resolve(input) : path.resolve(liveRoot, fromPosix(input));
  const relative = path.relative(liveRoot, absolute);
  if (
    !relative
    || path.isAbsolute(relative)
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error('hosted snapshot path escapes the live generation');
  }
  return relative.split(path.sep).join('/');
}

function logicalSessionPath(input: string, liveRoot: string): string {
  const logical = logicalLivePath(
    path.isAbsolute(input) || input.startsWith('sessions/') ? input : `sessions/${input}`,
    liveRoot,
  );
  if (!logical.startsWith('sessions/')) {
    throw new Error('hosted snapshot session reference is outside the session root');
  }
  return logical;
}

async function checksumPayload(
  payloadRoot: string,
  relativeFiles: readonly string[],
  limits: HostedSnapshotLimits,
): Promise<readonly SnapshotFileChecksum[]> {
  const files: SnapshotFileChecksum[] = [];
  let totalBytes = 0;
  for (const relative of relativeFiles) {
    const file = containedFile(payloadRoot, relative);
    const info = fs.lstatSync(file);
    totalBytes += info.size;
    if (totalBytes > limits.bytesPerVersion) {
      snapshotQuota('hosted snapshot byte quota exceeded');
    }
    files.push({ path: relative, sha256: await hashFile(file), size: info.size });
  }
  return Object.freeze(files);
}

async function inventoryTreeExact(
  root: string,
  limits: HostedSnapshotLimits,
): Promise<{ readonly directories: string[]; readonly files: string[] }> {
  const payloadFilesMaximum = Math.max(
    0,
    limits.filesPerVersion - IMMUTABLE_METADATA_FILE_COUNT,
  );
  const files: string[] = [];
  const directories: string[] = [];
  const pending: Array<{ readonly directory: string; readonly prefix: string }> = [{
    directory: assertDirectory(root),
    prefix: '',
  }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const handle = await fsp.opendir(current.directory);
    for await (const entry of handle) {
      const relative = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current.directory, entry.name);
      const info = await fsp.lstat(absolute);
      if (
        info.isSymbolicLink()
        || !await isExactRealChild(current.directory, entry.name)
      ) {
        throw new Error('hosted snapshot contains a link or reparse point');
      }
      if (info.isDirectory()) {
        directories.push(relative);
        if (directories.length > limits.filesPerVersion) {
          snapshotQuota('hosted snapshot directory quota exceeded');
        }
        pending.push({ directory: absolute, prefix: relative });
        continue;
      }
      if (!info.isFile()) throw new Error('hosted snapshot contains a special file');
      files.push(relative);
      if (files.length > payloadFilesMaximum) {
        snapshotQuota('hosted snapshot file quota exceeded');
      }
    }
  }
  directories.sort();
  files.sort();
  return { directories, files };
}

async function validateSnapshot(
  versionRoot: string,
  identity: HostedStorageIdentity,
  sequence: string,
  limits: HostedSnapshotLimits,
): Promise<ValidSnapshot> {
  const root = assertDirectory(versionRoot);
  await validateVersionRootShape(root);
  const completionText = readStrictText(path.join(root, '.complete.json'), 16 * 1024);
  const manifestText = readStrictText(path.join(root, 'manifest.json'), 64 * 1024);
  const checksumsText = readStrictText(
    path.join(root, 'checksums.json'),
    Math.min(16 * 1024 * 1024, limits.filesPerVersion * 256 + 1024),
  );
  const completion = parseCompletion(completionText, sequence);
  const manifest = parseManifest(manifestText, identity, sequence);
  const checksums = parseChecksums(
    checksumsText,
    sequence,
    Math.max(0, limits.filesPerVersion - IMMUTABLE_METADATA_FILE_COUNT),
    limits.filesPerVersion,
  );
  if (
    completion.manifestSha256 !== sha256(manifestText)
    || completion.checksumsSha256 !== sha256(checksumsText)
    || manifest.checksumsSha256 !== completion.checksumsSha256
  ) {
    throw new Error('hosted snapshot metadata checksum does not match');
  }
  if (manifest.fileCount !== checksums.files.length) {
    throw new Error('hosted snapshot file count does not match');
  }
  const metadataBytes = Buffer.byteLength(completionText)
    + Buffer.byteLength(manifestText)
    + Buffer.byteLength(checksumsText);
  if (
    metadataBytes > limits.bytesPerVersion
    || manifest.totalBytes > limits.bytesPerVersion - metadataBytes
  ) {
    throw new Error('hosted snapshot declared byte count exceeds its fixed limit');
  }
  let expectedBytes = 0;
  for (const expected of checksums.files) {
    if (expected.size > manifest.totalBytes - expectedBytes) {
      throw new Error('hosted snapshot expected byte count exceeds its manifest');
    }
    expectedBytes += expected.size;
  }
  if (expectedBytes !== manifest.totalBytes) {
    throw new Error('hosted snapshot expected byte count does not match');
  }
  const payloadRoot = assertDirectory(path.join(root, 'payload'), root);
  const inventory = await inventoryTreeExact(payloadRoot, limits);
  const actualDirectories = inventory.directories;
  if (
    actualDirectories.length !== checksums.directories.length
    || actualDirectories.some((directory, index) => directory !== checksums.directories[index])
  ) {
    throw new Error('hosted snapshot directory inventory does not match');
  }
  const actualFiles = inventory.files;
  if (
    actualFiles.length !== checksums.files.length
    || actualFiles.some((file, index) => file !== checksums.files[index]?.path)
  ) {
    throw new Error('hosted snapshot payload inventory does not match');
  }
  let totalBytes = 0;
  for (const expected of checksums.files) {
    const file = containedFile(payloadRoot, expected.path);
    const info = fs.lstatSync(file);
    if (
      info.size !== expected.size
      || info.size > manifest.totalBytes - totalBytes
    ) {
      throw new Error('hosted snapshot payload checksum does not match');
    }
    totalBytes += info.size;
    if (await hashFile(file) !== expected.sha256) {
      throw new Error('hosted snapshot payload checksum does not match');
    }
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new Error('hosted snapshot payload byte count does not match');
  }
  const bytesOnDisk = await directoryBytesAsync(
    root,
    limits.bytesPerVersion,
    versionEntryLimit(limits),
  );
  const databaseFile = containedFile(payloadRoot, 'app.sqlite');
  await withDatabaseCopy(databaseFile, async (copy) => {
    await validateSnapshotSessions(copy, payloadRoot);
    const database = new Database(copy, { fileMustExist: true, readonly: true });
    try {
      verifyDatabase(database);
    } finally {
      database.close();
    }
  });
  return {
    bytesOnDisk,
    files: checksums.files,
    manifest,
    root,
    sequence,
  };
}

async function validateVersionRootShape(root: string): Promise<void> {
  const expected = new Set([
    '.complete.json',
    'checksums.json',
    'manifest.json',
    'payload',
  ]);
  const handle = await fsp.opendir(root);
  let entries = 0;
  for await (const entry of handle) {
    entries += 1;
    if (entries > 4 || !expected.delete(entry.name)) {
      throw new Error('hosted snapshot version root contains an unexpected entry');
    }
    if (entry.name === 'payload' ? !entry.isDirectory() : !entry.isFile()) {
      throw new Error('hosted snapshot version root entry has an invalid shape');
    }
  }
  if (expected.size !== 0) {
    throw new Error('hosted snapshot version root is incomplete');
  }
}

function parseCompletion(text: string, sequence: string): SnapshotCompletion {
  const value = parseJsonText(text);
  assertExactKeys(value, ['checksumsSha256', 'manifestSha256', 'schema', 'sequence', 'version']);
  if (
    value.schema !== COMPLETION_SCHEMA
    || value.version !== SNAPSHOT_VERSION
    || value.sequence !== sequence
    || !isSha256(value.manifestSha256)
    || !isSha256(value.checksumsSha256)
  ) throw new Error('hosted snapshot completion marker is invalid');
  return value as unknown as SnapshotCompletion;
}

function parseManifest(
  text: string,
  identity: HostedStorageIdentity,
  sequence: string,
): SnapshotManifest {
  const value = parseJsonText(text);
  assertExactKeys(value, [
    'checksumsSha256',
    'derivationVersion',
    'fileCount',
    'schema',
    'sequence',
    'storageKey',
    'totalBytes',
    'userKey',
    'version',
  ]);
  if (
    value.schema !== SNAPSHOT_SCHEMA
    || value.version !== SNAPSHOT_VERSION
    || value.derivationVersion !== 1
    || value.sequence !== sequence
    || value.storageKey !== identity.storageKey
    || value.userKey !== identity.userKey
    || !nonNegativeSafeInteger(value.fileCount)
    || !nonNegativeSafeInteger(value.totalBytes)
    || !isSha256(value.checksumsSha256)
  ) throw new Error('hosted snapshot manifest is invalid');
  return value as unknown as SnapshotManifest;
}

function parseChecksums(
  text: string,
  sequence: string,
  fileLimit: number,
  directoryLimit: number,
): SnapshotChecksums {
  const value = parseJsonText(text);
  assertExactKeys(value, ['directories', 'files', 'schema', 'sequence', 'version']);
  if (
    value.schema !== CHECKSUM_SCHEMA
    || value.version !== SNAPSHOT_VERSION
    || value.sequence !== sequence
    || !Array.isArray(value.directories)
    || value.directories.length > directoryLimit
    || !Array.isArray(value.files)
    || value.files.length > fileLimit
  ) throw new Error('hosted snapshot checksum manifest is invalid');
  let previousDirectory = '';
  const directories = value.directories.map((directory) => {
    if (
      typeof directory !== 'string'
      || !isCanonicalRelativePath(directory)
      || directory <= previousDirectory
    ) throw new Error('hosted snapshot directory entry is invalid');
    previousDirectory = directory;
    return directory;
  });
  let previous = '';
  const files = value.files.map((item) => {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('hosted snapshot checksum entry is invalid');
    }
    const file = item as Record<string, unknown>;
    assertExactKeys(file, ['path', 'sha256', 'size']);
    if (
      typeof file.path !== 'string'
      || !isCanonicalRelativePath(file.path)
      || file.path <= previous
      || !nonNegativeSafeInteger(file.size)
      || !isSha256(file.sha256)
    ) throw new Error('hosted snapshot checksum entry is invalid');
    previous = file.path;
    return { path: file.path, sha256: file.sha256, size: file.size } as SnapshotFileChecksum;
  });
  return {
    directories,
    files,
    schema: CHECKSUM_SCHEMA,
    sequence,
    version: SNAPSHOT_VERSION,
  };
}

async function validateSnapshotSessions(databaseFile: string, payloadRoot: string): Promise<void> {
  const database = new Database(databaseFile, { fileMustExist: true, readonly: true });
  try {
    const sessions = database.prepare(
      `SELECT s.session_id AS sessionId, c.project_id AS projectId
         FROM agent_sessions s
         JOIN conversations c ON c.id = s.conversation_id`,
    ).all() as Array<{
      projectId: string;
      sessionId: string;
    }>;
    for (const row of sessions) {
      if (!isCanonicalRelativePath(row.sessionId) || !row.sessionId.startsWith('sessions/')) {
        throw new Error('hosted snapshot database session reference is invalid');
      }
      await validateLogicalSessionLineage(
        row.sessionId,
        payloadRoot,
        `projects/${row.projectId}`,
        new Set(),
        0,
      );
    }
  } finally {
    database.close();
  }
}

async function validateLogicalSessionLineage(
  logicalPath: string,
  payloadRoot: string,
  expectedCwd: string,
  seen: Set<string>,
  depth: number,
): Promise<void> {
  if (depth >= MAX_SESSION_PARENT_DEPTH || seen.has(logicalPath)) {
    throw new Error('hosted snapshot session closure is invalid');
  }
  seen.add(logicalPath);
  const { header } = await readSessionFileAsync(containedFile(payloadRoot, logicalPath));
  if (!isCanonicalRelativePath(header.cwd) || header.cwd !== expectedCwd) {
    throw new Error('hosted snapshot session cwd reference is invalid');
  }
  containedDirectory(payloadRoot, header.cwd);
  if (typeof header.parentSession === 'string') {
    if (!isCanonicalRelativePath(header.parentSession) || !header.parentSession.startsWith('sessions/')) {
      throw new Error('hosted snapshot session parent reference is invalid');
    }
    await validateLogicalSessionLineage(
      header.parentSession,
      payloadRoot,
      expectedCwd,
      seen,
      depth + 1,
    );
  }
  seen.delete(logicalPath);
}

async function stageSnapshotPayload(
  snapshot: ValidSnapshot,
  runtimeRoot: string,
  identity: HostedStorageIdentity,
  limits: HostedSnapshotLimits,
): Promise<string> {
  const payloadRoot = assertDirectory(path.join(snapshot.root, 'payload'), snapshot.root);
  const stagingRoot = await fsp.mkdtemp(
    path.join(runtimeRoot, `.restore-${identity.storageKey}-`),
  );
  activeRestoreStaging.add(stagingRoot);
  try {
    await copyTreeExact(payloadRoot, stagingRoot, createCaptureBudget(limits), '');
    return stagingRoot;
  } catch (error) {
    await removeRestoreStaging(stagingRoot, runtimeRoot);
    throw error;
  }
}

async function removeRestoreStaging(stagingRoot: string, runtimeRoot: string): Promise<void> {
  try {
    if (!fs.existsSync(stagingRoot)) return;
    const exact = assertDirectory(stagingRoot, runtimeRoot);
    await fsp.rm(exact, { force: true, recursive: true });
  } finally {
    activeRestoreStaging.delete(stagingRoot);
  }
}

function installStagedPayload(stagedPayload: string, generationRoot: string): void {
  const staging = assertDirectory(stagedPayload);
  const generation = assertDirectory(generationRoot);
  for (const name of PAYLOAD_DIRECTORIES) {
    const source = assertDirectory(path.join(staging, name), staging);
    const target = assertDirectory(path.join(generation, name), generation);
    fs.rmdirSync(target);
    fs.renameSync(source, target);
  }
  fs.renameSync(containedFile(staging, 'app.sqlite'), path.join(generation, 'app.sqlite'));
}

async function relocateRestoredSessions(
  database: Database.Database,
  generationRoot: string,
): Promise<void> {
  const rows = database.prepare(
      `SELECT s.conversation_id AS conversationId, s.agent_id AS agentId,
              s.session_id AS sessionId, c.project_id AS projectId
         FROM agent_sessions s
         JOIN conversations c ON c.id = s.conversation_id`,
    ).all() as Array<{
      conversationId: string;
      agentId: string;
      projectId: string;
      sessionId: string;
    }>;
  const relocated = new Map<string, string>();
  const updates: Array<{ conversationId: string; agentId: string; sessionId: string }> = [];
  for (const row of rows) {
    await relocateSessionLineage(
      row.sessionId,
      generationRoot,
      `projects/${row.projectId}`,
      relocated,
      new Set(),
      0,
    );
    updates.push({
      agentId: row.agentId,
      conversationId: row.conversationId,
      sessionId: containedFile(generationRoot, row.sessionId),
    });
  }
  const update = database.prepare(
    'UPDATE agent_sessions SET session_id = ? WHERE conversation_id = ? AND agent_id = ?',
  );
  const transaction = database.transaction(() => {
      for (const row of updates) {
        update.run(
          row.sessionId,
          row.conversationId,
          row.agentId,
        );
      }
  });
  transaction();
}

async function relocateSessionLineage(
  logicalPath: string,
  generationRoot: string,
  expectedCwd: string,
  relocated: Map<string, string>,
  active: Set<string>,
  depth: number,
): Promise<void> {
  const relocatedCwd = relocated.get(logicalPath);
  if (relocatedCwd != null) {
    if (relocatedCwd !== expectedCwd) {
      throw new Error('hosted snapshot session is owned by multiple projects');
    }
    return;
  }
  if (depth >= MAX_SESSION_PARENT_DEPTH || active.has(logicalPath)) {
    throw new Error('hosted snapshot restored session closure is invalid');
  }
  active.add(logicalPath);
  const file = containedFile(generationRoot, logicalPath);
  const session = await readSessionFileAsync(file);
  const { header } = session;
  if (!isCanonicalRelativePath(header.cwd) || header.cwd !== expectedCwd) {
    throw new Error('hosted snapshot session cwd is invalid');
  }
  header.cwd = containedDirectory(generationRoot, header.cwd);
  if (typeof header.parentSession === 'string') {
    const parent = header.parentSession;
    if (!isCanonicalRelativePath(parent)) throw new Error('hosted snapshot session parent is invalid');
    await relocateSessionLineage(
      parent,
      generationRoot,
      expectedCwd,
      relocated,
      active,
      depth + 1,
    );
    header.parentSession = containedFile(generationRoot, parent);
  }
  await rewriteSessionHeaderAsync(file, session, header);
  active.delete(logicalPath);
  relocated.set(logicalPath, expectedCwd);
}

function openRestoredDatabase(databaseFile: string): Database.Database {
  const database = openHostedDatabaseAtPath(databaseFile);
  verifyDatabase(database);
  return database;
}

async function withDatabaseCopy<T>(
  databaseFile: string,
  use: (copy: string) => Promise<T>,
): Promise<T> {
  let root: string;
  try {
    root = await fsp.mkdtemp(path.join(tmpdir(), 'readable-hosted-snapshot-db-'));
  } catch (error) {
    throw new SnapshotValidationIoError(
      'hosted snapshot database validation staging failed',
      error,
    );
  }
  const copy = path.join(root, 'app.sqlite');
  let validationError: unknown;
  try {
    try {
      await fsp.copyFile(databaseFile, copy, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      throw new SnapshotValidationIoError(
        'hosted snapshot database validation copy failed',
        error,
      );
    }
    try {
      return await use(copy);
    } catch (error) {
      validationError = error;
      throw error;
    }
  } finally {
    try {
      await fsp.rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new SnapshotValidationIoError(
        'hosted snapshot database validation cleanup failed',
        validationError == null
          ? cleanupError
          : new AggregateError([validationError, cleanupError]),
      );
    }
  }
}

function verifyDatabase(database: Database.Database): void {
  if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new Error('hosted snapshot database integrity check failed');
  }
  if ((database.pragma('foreign_key_check') as unknown[]).length !== 0) {
    throw new Error('hosted snapshot database ownership references are invalid');
  }
}

async function preflightRetention(options: {
  readonly completionBytes: number;
  readonly runtimeRoot: string;
  readonly sequence: string;
  readonly snapshotRoot: string;
  readonly stagingRoot: string;
  readonly versionsRoot: string;
  readonly identity: HostedStorageIdentity;
  readonly limits: HostedSnapshotLimits;
}): Promise<void> {
  await scavengeRetiredVersions(options.versionsRoot);
  await pruneUnreachableVersions(options.versionsRoot, options.identity, options.limits);
  const latestFile = path.join(options.snapshotRoot, 'latest');
  const latestBytes = Buffer.byteLength(`${options.sequence}\n`);
  const replacedLatestBytes = existingRegularFileBytes(latestFile);
  const stagingBytes = await directoryBytesAsync(
    assertDirectory(options.stagingRoot, options.snapshotRoot),
    options.limits.bytesPerVersion,
    versionEntryLimit(options.limits),
  );
  const retainedVersionBytes = await existingVersionBytes(
    options.versionsRoot,
    options.limits,
  );
  const currentUserBytes = await directoryBytesAsync(
    options.snapshotRoot,
    Number.MAX_SAFE_INTEGER,
    userSnapshotEntryLimit(options.limits),
  );
  const allVersionBytes = retainedVersionBytes.reduce(
    (sum, version) => sum + version.bytes,
    0,
  );
  const stableUserOverhead = currentUserBytes
    - stagingBytes
    - allVersionBytes
    - replacedLatestBytes;
  if (stableUserOverhead < 0) {
    throw new Error('hosted snapshot retained byte accounting is invalid');
  }
  const newestPreviousBytes = retainedVersionBytes[0]?.bytes ?? 0;
  const projectedUserBytes = stableUserOverhead
    + stagingBytes
    + options.completionBytes
    + newestPreviousBytes
    + latestBytes;
  if (projectedUserBytes > options.limits.retainedBytesPerUser) {
    snapshotQuota('hosted snapshot retained user byte quota exceeded');
  }

  const snapshotsRoot = assertDirectory(path.join(options.runtimeRoot, 'snapshots'), options.runtimeRoot);
  await scavengeGlobalPublicationStaging(snapshotsRoot);
  await pruneGlobalReachableVersions(snapshotsRoot, options.limits);
  const currentGlobalBytes = await directoryBytesAsync(
    snapshotsRoot,
    Number.MAX_SAFE_INTEGER,
    MAX_GLOBAL_QUOTA_WALK_ENTRIES,
    'capacity',
  );
  const currentUserBytesAfterGlobalPrune = await directoryBytesAsync(
    options.snapshotRoot,
    Number.MAX_SAFE_INTEGER,
    userSnapshotEntryLimit(options.limits),
  );
  const transientStagingBytes = await globalStagingBytes(snapshotsRoot, options.limits);
  const otherTransientStagingBytes = transientStagingBytes - stagingBytes;
  if (otherTransientStagingBytes < 0) {
    throw new Error('hosted snapshot global staging byte accounting is invalid');
  }
  const projectedGlobalBytes = currentGlobalBytes
    - currentUserBytesAfterGlobalPrune
    - otherTransientStagingBytes
    + projectedUserBytes;
  if (projectedGlobalBytes > options.limits.retainedBytesGlobal) {
    snapshotCapacity('hosted snapshot retained global byte capacity exhausted');
  }
}

async function scavengeGlobalPublicationStaging(snapshotsRoot: string): Promise<void> {
  for (const userEntry of await fsp.readdir(snapshotsRoot, { withFileTypes: true })) {
    if (!userEntry.isDirectory() || !/^od1_[0-9a-f]{64}$/u.test(userEntry.name)) continue;
    const userRoot = assertDirectory(path.join(snapshotsRoot, userEntry.name), snapshotsRoot);
    for (const entry of await fsp.readdir(userRoot, { withFileTypes: true })) {
      if (!/^\.staging-\d{20}-/u.test(entry.name)) continue;
      const stagingRoot = path.join(userRoot, entry.name);
      if ([...activePublicationStaging].some((active) => samePath(active, stagingRoot))) {
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('hosted snapshot publication staging path is invalid');
      }
      await removeExactDirectory(stagingRoot, userRoot);
    }
  }
}

async function globalStagingBytes(
  snapshotsRoot: string,
  limits: HostedSnapshotLimits,
): Promise<number> {
  let total = 0;
  for (const userEntry of await fsp.readdir(snapshotsRoot, { withFileTypes: true })) {
    if (!userEntry.isDirectory() || !/^od1_[0-9a-f]{64}$/u.test(userEntry.name)) continue;
    const userRoot = assertDirectory(path.join(snapshotsRoot, userEntry.name), snapshotsRoot);
    for (const entry of await fsp.readdir(userRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith('.staging-')) continue;
      const stagingRoot = path.join(userRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('hosted snapshot global staging path is invalid');
      }
      total += await directoryBytesAsync(
        stagingRoot,
        Number.MAX_SAFE_INTEGER,
        versionEntryLimit(limits),
      );
    }
  }
  return total;
}

async function existingVersionBytes(
  versionsRoot: string,
  limits: HostedSnapshotLimits,
): Promise<ReadonlyArray<{ readonly bytes: number; readonly sequence: string }>> {
  const versions: Array<{ bytes: number; sequence: string }> = [];
  for (const sequence of listVersionSequences(versionsRoot).reverse()) {
    versions.push({
      bytes: await directoryBytesAsync(
        path.join(versionsRoot, sequence),
        Number.MAX_SAFE_INTEGER,
        versionEntryLimit(limits),
      ),
      sequence,
    });
  }
  return versions;
}

function existingRegularFileBytes(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const info = fs.lstatSync(file);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || !samePath(fs.realpathSync(file), path.resolve(file))
  ) {
    return 0;
  }
  return info.size;
}

async function pruneGlobalReachableVersions(
  snapshotsRoot: string,
  limits: HostedSnapshotLimits,
): Promise<void> {
  for (const entry of fs.readdirSync(snapshotsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^od1_[0-9a-f]{64}$/u.test(entry.name)) continue;
    const userRoot = assertDirectory(path.join(snapshotsRoot, entry.name), snapshotsRoot);
    let marker: Record<string, unknown>;
    try {
      marker = readStrictJson(path.join(userRoot, '.identity.json'), 4 * 1024);
      assertExactKeys(marker, ['derivationVersion', 'storageKey', 'userKey']);
    } catch {
      continue;
    }
    if (
      marker.derivationVersion !== 1
      || marker.storageKey !== entry.name
      || typeof marker.userKey !== 'string'
    ) continue;
    const versionsRoot = path.join(userRoot, 'versions');
    if (!fs.existsSync(versionsRoot)) continue;
    const identity = { storageKey: entry.name, userKey: marker.userKey };
    await pruneUnreachableVersions(
      assertDirectory(versionsRoot, userRoot),
      identity,
      limits,
    );
  }
}

async function pruneRetainedVersions(
  runtimeRoot: string,
  identity: HostedStorageIdentity,
  limits: HostedSnapshotLimits,
): Promise<void> {
  const versionsRoot = path.join(runtimeRoot, 'snapshots', identity.storageKey, 'versions');
  await pruneUnreachableVersions(versionsRoot, identity, limits);
}

async function pruneUnreachableVersions(
  versionsRoot: string,
  identity: HostedStorageIdentity,
  limits: HostedSnapshotLimits,
): Promise<void> {
  const valid: ValidSnapshot[] = [];
  const invalid: string[] = [];
  for (const sequence of listVersionSequences(versionsRoot).reverse()) {
    const root = path.join(versionsRoot, sequence);
    try {
      valid.push(await validateSnapshot(root, identity, sequence, limits));
    } catch (error) {
      if (isTransientSnapshotValidationError(error)) throw error;
      invalid.push(root);
    }
  }
  for (const root of invalid) {
    await removeInvalidSnapshotEntry(root, versionsRoot);
  }
  for (const snapshot of valid.slice(2)) {
    const retired = path.join(
      versionsRoot,
      `.retired-${path.basename(snapshot.root)}-${randomUUID()}`,
    );
    fs.renameSync(assertDirectory(snapshot.root, versionsRoot), retired);
    try {
      await removeExactDirectory(retired, versionsRoot);
    } catch {
      // The atomic rename already removed this version from restore authority.
      // A later restore/publication must scavenge it before accepting more work.
    }
  }
}

async function scavengeRetiredVersions(versionsRoot: string): Promise<void> {
  for (const entry of fs.readdirSync(assertDirectory(versionsRoot), { withFileTypes: true })) {
    if (!entry.name.startsWith('.retired-')) continue;
    const target = path.join(versionsRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('hosted snapshot retired entry is invalid');
    }
    await removeExactDirectory(target, versionsRoot);
  }
}

async function removeInvalidSnapshotEntry(target: string, parent: string): Promise<void> {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || path.isAbsolute(relative) || relative.includes(path.sep) || relative === '..') {
    throw new Error('hosted snapshot invalid entry escapes its owner');
  }
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink()) {
    throw new Error('hosted snapshot invalid entry is a link');
  }
  if (info.isDirectory()) {
    await removeExactDirectory(target, parent);
    return;
  }
  if (!info.isFile()) throw new Error('hosted snapshot invalid entry is unsupported');
  await fsp.unlink(target);
}

function listVersionSequences(versionsRoot: string): string[] {
  return fs.readdirSync(assertDirectory(versionsRoot), { withFileTypes: true })
    .filter((entry) => /^\d{20}$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function writeLatestHint(snapshotRoot: string, sequence: string): void {
  const temporary = path.join(snapshotRoot, `.latest-${randomUUID()}.tmp`);
  try {
    writeDurable(temporary, `${sequence}\n`, 'wx');
    fs.renameSync(temporary, path.join(snapshotRoot, 'latest'));
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function containedFile(root: string, relative: string): string {
  const target = containedTarget(root, relative);
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(fs.realpathSync(target), target)) {
    throw new Error('hosted snapshot path is not a regular owned file');
  }
  return target;
}

function containedDirectory(root: string, relative: string): string {
  return assertDirectory(containedTarget(root, relative));
}

function containedTarget(root: string, relative: string): string {
  if (!isCanonicalRelativePath(relative)) throw new Error('hosted snapshot relative path is invalid');
  const target = path.resolve(root, fromPosix(relative));
  const relation = path.relative(root, target);
  if (!relation || path.isAbsolute(relation) || relation.startsWith(`..${path.sep}`) || relation === '..') {
    throw new Error('hosted snapshot path escapes its root');
  }
  return target;
}

function isCanonicalRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) return false;
  if (path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value
    && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

function fromPosix(relative: string): string {
  return relative.split('/').join(path.sep);
}

function samePath(left: string, right: string): boolean {
  if (process.platform !== 'win32') return path.resolve(left) === path.resolve(right);
  return comparableWindowsPath(left) === comparableWindowsPath(right);
}

function comparableWindowsPath(input: string): string {
  return path.win32.normalize(withoutWindowsNamespace(input)).toLowerCase();
}

function withoutWindowsNamespace(input: string): string {
  if (process.platform !== 'win32') return input;
  return input.startsWith('\\\\?\\UNC\\')
    ? `\\\\${input.slice(8)}`
    : input.startsWith('\\\\?\\')
      ? input.slice(4)
      : input;
}

function assertDirectory(input: string, parent?: string): string {
  const expected = path.resolve(input);
  const info = fs.lstatSync(expected);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('hosted snapshot path must be a real directory');
  }
  const resolved = fs.realpathSync(expected);
  if (!samePath(resolved, expected)) {
    throw new Error('hosted snapshot path resolves through a link or reparse point');
  }
  if (parent != null) {
    const relation = path.relative(parent, resolved);
    if (!relation || path.isAbsolute(relation) || relation.includes(path.sep) || relation === '..') {
      throw new Error('hosted snapshot path escapes its owning directory');
    }
  }
  return resolved;
}

function prepareBaseDirectory(input: string): string {
  const ordinaryInput = withoutWindowsNamespace(input);
  if (!path.isAbsolute(ordinaryInput)) {
    throw new Error('hosted snapshot runtime root must be absolute');
  }
  const missing: string[] = [];
  let current = path.resolve(ordinaryInput);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('hosted snapshot runtime root is unavailable');
    missing.unshift(path.basename(current));
    current = parent;
  }
  current = assertDirectory(current);
  for (const name of missing) current = ensureDirectory(current, name);
  return current;
}

async function removeExactDirectory(target: string, parent: string): Promise<void> {
  if (!fs.existsSync(target)) return;
  const exact = assertDirectory(target, parent);
  await fsp.rm(exact, { recursive: true, force: true });
}

function versionEntryLimit(limits: HostedSnapshotLimits): number {
  return limits.filesPerVersion * 2 + 8;
}

function userSnapshotEntryLimit(limits: HostedSnapshotLimits): number {
  return limits.filesPerVersion * 6 + 64;
}

async function directoryBytesAsync(
  root: string,
  maximum: number,
  maximumEntries: number,
  exhaustion: 'capacity' | 'quota' = 'quota',
): Promise<number> {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  let entries = 0;
  const pending = [assertDirectory(root)];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const handle = await fsp.opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > maximumEntries) {
        if (exhaustion === 'capacity') {
          snapshotCapacity('hosted snapshot global entry capacity exhausted');
        }
        snapshotQuota('hosted snapshot retained entry quota exceeded');
      }
      const target = path.join(directory, entry.name);
      const info = await fsp.lstat(target);
      if (
        info.isSymbolicLink()
        || !await isExactRealChild(directory, entry.name)
      ) {
        throw new Error('hosted snapshot quota path contains a link or reparse point');
      }
      if (info.isFile()) {
        total += info.size;
        if (total > maximum) snapshotQuota('hosted snapshot retained byte quota exceeded');
        continue;
      }
      if (!info.isDirectory()) {
        throw new Error('hosted snapshot quota path contains a special file');
      }
      pending.push(target);
    }
  }
  return total;
}

async function isExactRealChild(parent: string, name: string): Promise<boolean> {
  const [realParent, realChild] = await Promise.all([
    fsp.realpath(parent),
    fsp.realpath(path.join(parent, name)),
  ]);
  return samePath(realChild, path.join(realParent, name));
}

function writeDurable(file: string, contents: string, flag: 'w' | 'wx' = 'w'): void {
  const descriptor = fs.openSync(file, flag, 0o600);
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function syncFileAsync(file: string): Promise<void> {
  const handle = await fsp.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readStrictJson(file: string, maxBytes: number): Record<string, unknown> {
  return parseJsonText(readStrictText(file, maxBytes));
}

function readStrictText(file: string, maxBytes: number): string {
  const target = path.resolve(file);
  const info = fs.lstatSync(target);
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size < 1
    || info.size > maxBytes
    || !samePath(fs.realpathSync(target), target)
  ) throw new Error('hosted snapshot metadata file is invalid');
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(target));
}

function parseJsonText(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hosted snapshot metadata object is invalid');
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error('hosted snapshot metadata contains unknown or missing fields');
  }
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isTransientSnapshotValidationError(error: unknown): boolean {
  if (error instanceof SnapshotValidationIoError) return true;
  if (error == null || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException & { code?: string }).code;
  return code === 'EACCES'
    || code === 'EBUSY'
    || code === 'EIO'
    || code === 'EMFILE'
    || code === 'ENFILE'
    || code === 'ENOMEM'
    || code === 'EPERM'
    || code === 'SQLITE_BUSY'
    || code === 'SQLITE_CANTOPEN'
    || code === 'SQLITE_FULL'
    || code === 'SQLITE_NOMEM'
    || code === 'SQLITE_READONLY'
    || (typeof code === 'string' && code.startsWith('SQLITE_IOERR'));
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function fire(
  failpoint: HostedSnapshotStoreOptions['failpoint'],
  name: HostedSnapshotFailpoint,
): Promise<void> {
  await failpoint?.(name);
}
