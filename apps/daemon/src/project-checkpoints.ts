import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import type {
  ProjectCheckpointConflict,
  ProjectCheckpointDiffResponse,
  ProjectCheckpointFileDelta,
  ProjectCheckpointKind,
  ProjectCheckpointSummary,
  RollbackConflictPolicy,
  RollbackFileChangeCounts,
  RollbackMode,
  RollbackResponse,
} from '@readable-studio/contracts';
import {
  clearAgentSessionsForConversation,
  deleteMessagesAfterPosition,
  deletePreviewCommentsAfter,
  findProjectCheckpointForMessage,
  getAgentRollbackRestoreCountForRun,
  getConversation,
  getMessagePosition,
  getMessageRunId,
  getProject,
  getProjectCheckpoint,
  insertProjectCheckpoint,
  insertProjectCheckpointRestore,
  listProjectCheckpoints,
  type DbProjectCheckpointRow,
} from './db.js';
import { isIgnoredProjectDirName } from './project-ignored-dirs.js';
import { resolveProjectDir } from './projects.js';

type SqliteDb = any;
type ProjectRecord = { id: string; metadata?: unknown };

const CHECKPOINTS_DIR_NAME = 'checkpoints';
const BLOB_ALGORITHM = 'sha256';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const TRANSIENT_DOT_DIRS = new Set(['.git', '.readable-studio', '.tmp', '.readable-studio-skills']);
const TRANSIENT_DOT_FILES = new Set(['.mcp.json']);

export class ProjectCheckpointError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ProjectCheckpointError';
    this.status = status;
    this.code = code;
  }
}

export class ProjectCheckpointConflictError extends ProjectCheckpointError {
  readonly conflicts: ProjectCheckpointConflict[];
  readonly safetyCheckpointId: string | null;

  constructor(conflicts: ProjectCheckpointConflict[], safetyCheckpointId: string | null) {
    super(409, 'ROLLBACK_CONFLICT', 'Rollback has file conflicts.');
    this.name = 'ProjectCheckpointConflictError';
    this.conflicts = conflicts;
    this.safetyCheckpointId = safetyCheckpointId;
  }
}

export class ProjectCheckpointRunMismatchError extends ProjectCheckpointError {
  constructor() {
    super(403, 'ROLLBACK_RUN_MISMATCH', 'rollback target does not belong to the specified run');
    this.name = 'ProjectCheckpointRunMismatchError';
  }
}

export class ProjectCheckpointLoopError extends ProjectCheckpointError {
  constructor() {
    super(429, 'ROLLBACK_LOOP_PREVENTED', 'agent rollback limit reached for this run');
    this.name = 'ProjectCheckpointLoopError';
  }
}

export class ProjectCheckpointActiveRunError extends ProjectCheckpointError {
  constructor() {
    super(409, 'ACTIVE_RUN', 'cannot rollback while a run is active');
    this.name = 'ProjectCheckpointActiveRunError';
  }
}

interface ProjectCheckpointServiceOptions {
  db: SqliteDb;
  dataDir: string;
  projectsRoot: string;
}

interface CaptureCheckpointInput {
  projectId: string;
  conversationId?: string | null;
  messageId?: string | null;
  runId?: string | null;
  kind: ProjectCheckpointKind;
}

interface RollbackInput {
  projectId: string;
  conversationId: string;
  targetMessageId: string;
  targetCheckpointId?: string | null;
  mode: RollbackMode;
  conflictPolicy?: RollbackConflictPolicy;
  /**
   * Kept for wire/back-compat. File rollback always creates a safety checkpoint.
   */
  createSafetyCheckpoint?: boolean;
  /** Scope the rollback to the current run; required for actor='agent'. */
  runId?: string | null;
  /** Who initiated the rollback. Defaults to 'user'. */
  actor?: 'user' | 'agent';
  /** Trusted desktop approval attached to the restore audit row. */
  approvalRequestId?: string | null;
  /** Working-tree revision approved by the trusted desktop for an agent restore. */
  expectedRevision?: string | null;
}

export interface PreparedAgentRollback {
  targetCheckpointId: string;
  revision: string;
  fileChanges: RollbackFileChangeCounts;
  conflicts: ProjectCheckpointConflict[];
}

interface SnapshotFileEntry {
  path: string;
  kind: 'file';
  size: number;
  mtimeMs: number;
  mode: number;
  hash: string;
  blob: string;
}

interface SnapshotExcludedEntry {
  path: string;
  reason:
    | 'ignored_dir'
    | 'dot_entry'
    | 'transient'
    | 'symlink'
    | 'special_file'
    | 'oversized_file'
    | 'read_error';
}

interface CheckpointManifest {
  schemaVersion: 1;
  checkpointId: string;
  projectId: string;
  conversationId: string | null;
  messageId: string | null;
  runId: string | null;
  kind: ProjectCheckpointKind;
  createdAt: number;
  rootPathHash: string;
  files: SnapshotFileEntry[];
  excluded: SnapshotExcludedEntry[];
}

interface SnapshotResult {
  manifest: CheckpointManifest;
  manifestHash: string;
  manifestPath: string;
  totalBytes: number;
}

interface SnapshotOptions {
  blobWriter?: (blob: string, buffer: Buffer) => Promise<void>;
  persistManifest?: boolean;
}

interface FileMaps {
  target: Map<string, SnapshotFileEntry>;
  current: Map<string, SnapshotFileEntry>;
  baseline: Map<string, SnapshotFileEntry> | null;
}

interface RestoreFilesResult {
  fileChanges: RollbackFileChangeCounts;
  conflicts: ProjectCheckpointConflict[];
}

type VerifiedBlobSources = Map<string, string>;

interface RestorePathPreflight {
  conflicts: ProjectCheckpointConflict[];
  skipPaths: Set<string>;
}

export interface ProjectCheckpointService {
  captureCheckpoint(input: CaptureCheckpointInput): Promise<ProjectCheckpointSummary>;
  listCheckpoints(projectId: string, conversationId?: string | null): ProjectCheckpointSummary[];
  getCheckpoint(projectId: string, checkpointId: string): ProjectCheckpointSummary;
  diffCheckpoint(projectId: string, checkpointId: string): Promise<ProjectCheckpointDiffResponse>;
  prepareAgentRollback(input: {
    projectId: string;
    conversationId: string;
    targetMessageId: string;
    targetCheckpointId: string;
    runId: string;
  }): Promise<PreparedAgentRollback>;
  rollback(input: RollbackInput): Promise<RollbackResponse>;
}

export function createProjectCheckpointService(
  options: ProjectCheckpointServiceOptions,
): ProjectCheckpointService {
  const locks = new Map<string, Promise<unknown>>();

  async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current, () => current);
    locks.set(projectId, chained);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(projectId) === chained) locks.delete(projectId);
    }
  }

  async function captureCheckpoint(input: CaptureCheckpointInput): Promise<ProjectCheckpointSummary> {
    return withProjectLock(input.projectId, () => captureCheckpointUnlocked(input));
  }

  async function captureCheckpointUnlocked(input: CaptureCheckpointInput): Promise<ProjectCheckpointSummary> {
    const project = requireProject(input.projectId);
    const existing = input.kind === 'after_message' && input.messageId
      ? findProjectCheckpointForMessage(options.db, {
          projectId: input.projectId,
          conversationId: input.conversationId ?? '',
          messageId: input.messageId,
          kinds: [input.kind],
        })
      : null;
    const checkpointId = existing?.id ?? randomUUID();
    const createdAt = Date.now();
    const snapshot = await snapshotProject(project, {
      checkpointId,
      projectId: input.projectId,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      createdAt,
    });
    return insertCapturedCheckpoint(snapshot, createdAt);
  }

  function insertCapturedCheckpoint(snapshot: SnapshotResult, createdAt: number): ProjectCheckpointSummary {
    const manifest = snapshot.manifest;
    const row = insertProjectCheckpoint(options.db, {
      id: manifest.checkpointId,
      projectId: manifest.projectId,
      conversationId: manifest.conversationId,
      messageId: manifest.messageId,
      runId: manifest.runId,
      kind: manifest.kind,
      rootPathHash: manifest.rootPathHash,
      manifestHash: snapshot.manifestHash,
      manifestPath: snapshot.manifestPath,
      fileCount: manifest.files.length,
      totalBytes: snapshot.totalBytes,
      createdAt,
      metadata: {
        excludedCount: manifest.excluded.length,
      },
    });
    return toSummary(row);
  }

  function listCheckpoints(projectId: string, conversationId?: string | null): ProjectCheckpointSummary[] {
    requireProject(projectId);
    return listProjectCheckpoints(
      options.db,
      projectId,
      conversationId === undefined ? {} : { conversationId },
    )
      .map(toSummary);
  }

  function getCheckpoint(projectId: string, checkpointId: string): ProjectCheckpointSummary {
    requireProject(projectId);
    const row = requireCheckpoint(projectId, checkpointId);
    return toSummary(row);
  }

  async function diffCheckpoint(
    projectId: string,
    checkpointId: string,
  ): Promise<ProjectCheckpointDiffResponse> {
    return withProjectLock(projectId, async () => {
      const project = requireProject(projectId);
      const checkpoint = requireCheckpoint(projectId, checkpointId);
      const target = await readManifest(checkpoint);
      const current = await snapshotTransient(project, target);
      const baseline = await selectBaselineManifest(projectId, checkpoint);
      const maps = makeFileMaps(target, current, baseline);
      const root = resolveProjectDir(options.projectsRoot, project.id, project.metadata);
      const rootReal = await realpath(root).catch(() => root);
      const pathPreflight = await detectRestorePathBlockers(root, rootReal, maps);
      return {
        checkpoint: toSummary(checkpoint),
        baseCheckpoint: baseline ? toSummary(baseline.row) : null,
        files: diffFileMaps(maps),
        conflicts: mergeConflicts(detectConflicts(maps), pathPreflight.conflicts),
      };
    });
  }

  async function prepareAgentRollback(input: {
    projectId: string;
    conversationId: string;
    targetMessageId: string;
    targetCheckpointId: string;
    runId: string;
  }): Promise<PreparedAgentRollback> {
    return withProjectLock(input.projectId, async () => {
      const project = requireProject(input.projectId);
      const conversation = getConversation(options.db, input.conversationId);
      if (!conversation || conversation.projectId !== input.projectId) {
        throw new ProjectCheckpointError(404, 'CONVERSATION_NOT_FOUND', 'conversation not found');
      }
      if (getMessageRunId(options.db, input.conversationId, input.targetMessageId) !== input.runId) {
        throw new ProjectCheckpointRunMismatchError();
      }
      if (getAgentRollbackRestoreCountForRun(options.db, input.runId) >= 1) {
        throw new ProjectCheckpointLoopError();
      }
      const checkpoint = requireCheckpoint(input.projectId, input.targetCheckpointId);
      assertCheckpointMatchesRollbackTarget(checkpoint, input);
      if (checkpoint.kind !== 'before_run' || checkpoint.runId !== input.runId) {
        throw new ProjectCheckpointRunMismatchError();
      }
      const target = await readManifest(checkpoint);
      await assertManifestRootMatchesProject(project, target);
      const current = await snapshotTransient(project, target);
      const baseline = await selectBaselineManifest(input.projectId, checkpoint);
      const maps = makeFileMaps(target, current, baseline);
      const root = resolveProjectDir(options.projectsRoot, project.id, project.metadata);
      const rootReal = await realpath(root).catch(() => root);
      const pathPreflight = await detectRestorePathBlockers(root, rootReal, maps);
      const files = diffFileMaps(maps);
      return {
        targetCheckpointId: checkpoint.id,
        revision: manifestRevision(current),
        fileChanges: countFileChanges(files),
        conflicts: mergeConflicts(detectConflicts(maps), pathPreflight.conflicts),
      };
    });
  }

  async function rollback(input: RollbackInput): Promise<RollbackResponse> {
    return withProjectLock(input.projectId, async () => {
      const project = requireProject(input.projectId);
      const conversation = getConversation(options.db, input.conversationId);
      if (!conversation || conversation.projectId !== input.projectId) {
        throw new ProjectCheckpointError(404, 'CONVERSATION_NOT_FOUND', 'conversation not found');
      }
      const targetMessage = getMessagePosition(
        options.db,
        input.conversationId,
        input.targetMessageId,
      );
      if (!targetMessage) {
        throw new ProjectCheckpointError(404, 'MESSAGE_NOT_FOUND', 'message not found');
      }
      const actor = input.actor === 'agent' ? 'agent' : 'user';
      const mode = normalizeRollbackMode(input.mode);
      if (input.runId) {
        const messageRunId = getMessageRunId(options.db, input.conversationId, input.targetMessageId);
        if (messageRunId !== input.runId) {
          throw new ProjectCheckpointRunMismatchError();
        }
      }
      if (actor === 'agent') {
        if (!input.runId) {
          throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'runId is required for agent rollback');
        }
        if (mode !== 'files_only') {
          throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'agent rollback only supports files_only');
        }
        const agentRestoreCount = getAgentRollbackRestoreCountForRun(options.db, input.runId);
        if (agentRestoreCount >= 1) {
          throw new ProjectCheckpointLoopError();
        }
      }
      const conflictPolicy = normalizeRollbackConflictPolicy(
        input.conflictPolicy === undefined ? 'fail' : input.conflictPolicy,
      );
      let restoredCheckpointId: string | null = null;
      let safetyCheckpointId: string | null = null;
      let fileChanges = emptyFileChanges();
      let conflicts: ProjectCheckpointConflict[] = [];
      let targetCheckpoint: DbProjectCheckpointRow | null = null;
      let targetManifest: CheckpointManifest | null = null;
      let targetBlobSources: VerifiedBlobSources | null = null;
      let approvedCurrentManifest: CheckpointManifest | null = null;
      let expectedRevision: string | null = null;

      if (input.targetCheckpointId) {
        targetCheckpoint = requireCheckpoint(input.projectId, input.targetCheckpointId);
        assertCheckpointMatchesRollbackTarget(targetCheckpoint, {
          conversationId: input.conversationId,
          targetMessageId: input.targetMessageId,
        });
      }

      if (mode === 'files_only' || mode === 'files_and_chat') {
        targetCheckpoint = targetCheckpoint
          ?? findProjectCheckpointForMessage(options.db, {
              projectId: input.projectId,
              conversationId: input.conversationId,
              messageId: input.targetMessageId,
              // Inferred targets exclude safety snapshots. Users may still
              // explicitly select one to recover from a manual rollback.
              kinds: actor === 'agent'
                ? ['before_run']
                : ['after_message', 'after_run_unfinalized', 'before_run'],
            });
        if (!targetCheckpoint) {
          throw new ProjectCheckpointError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
        }
        assertCheckpointMatchesRollbackTarget(targetCheckpoint, {
          conversationId: input.conversationId,
          targetMessageId: input.targetMessageId,
        });
        if (actor === 'agent') {
          if (targetCheckpoint.runId !== input.runId) {
            throw new ProjectCheckpointRunMismatchError();
          }
          if (targetCheckpoint.kind !== 'before_run') {
            throw new ProjectCheckpointError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
          }
        }
        targetManifest = await readManifest(targetCheckpoint);
        await assertManifestRootMatchesProject(project, targetManifest);
        targetBlobSources = await preflightTargetBlobs(targetManifest);
      }

      if (actor === 'agent') {
        if (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expectedRevision)) {
          throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'expectedRevision is required for agent rollback');
        }
        expectedRevision = input.expectedRevision.toLowerCase();
      }

      if (expectedRevision && targetManifest) {
        const checkpointId = randomUUID();
        const createdAt = Date.now();
        const stagingDir = path.join(options.dataDir, CHECKPOINTS_DIR_NAME, 'staging', checkpointId);
        try {
          const snapshot = await snapshotProject(project, {
            checkpointId,
            projectId: input.projectId,
            conversationId: input.conversationId,
            messageId: input.targetMessageId,
            runId: targetCheckpoint?.runId ?? null,
            kind: 'before_restore',
            createdAt,
          }, {
            blobWriter: (blob, buffer) => writeStagedBlob(stagingDir, blob, buffer),
            persistManifest: false,
          });
          if (manifestRevision(snapshot.manifest) !== expectedRevision) {
            throw new ProjectCheckpointError(409, 'ROLLBACK_PLAN_CHANGED', 'rollback plan changed after approval');
          }
          await publishStagedBlobs(snapshot.manifest, stagingDir);
          await writeSnapshotManifest(snapshot);
          safetyCheckpointId = insertCapturedCheckpoint(snapshot, createdAt).id;
          approvedCurrentManifest = snapshot.manifest;
        } finally {
          await rm(stagingDir, { recursive: true, force: true });
        }
      } else {
        const safety = await captureCheckpointUnlocked({
          projectId: input.projectId,
          conversationId: input.conversationId,
          messageId: input.targetMessageId,
          runId: targetCheckpoint?.runId ?? null,
          kind: 'before_restore',
        });
        safetyCheckpointId = safety.id;
      }

      if (mode === 'files_only' || mode === 'files_and_chat') {
        if (!targetCheckpoint || !targetManifest || !targetBlobSources) {
          throw new ProjectCheckpointError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
        }
        const result = await restoreFiles({
          project,
          targetCheckpoint,
          targetManifest,
          targetBlobSources,
          conflictPolicy,
          safetyCheckpointId,
          currentManifest: approvedCurrentManifest,
        });
        fileChanges = result.fileChanges;
        conflicts = result.conflicts;
        restoredCheckpointId = targetCheckpoint.id;
      }

      let deletedMessageIds: string[] = [];
      let clearedAgentSessions = false;
      if (mode === 'chat_only' || mode === 'files_and_chat') {
        deletedMessageIds = deleteMessagesAfterPosition(
          options.db,
          input.conversationId,
          targetMessage.position,
        );
        if (typeof targetMessage.createdAt === 'number') {
          deletePreviewCommentsAfter(
            options.db,
            input.projectId,
            input.conversationId,
            targetMessage.createdAt,
          );
        }
        clearAgentSessionsForConversation(options.db, input.conversationId);
        clearedAgentSessions = true;
      }

      insertProjectCheckpointRestore(options.db, {
        id: randomUUID(),
        projectId: input.projectId,
        conversationId: input.conversationId,
        targetMessageId: input.targetMessageId,
        targetCheckpointId: restoredCheckpointId,
        safetyCheckpointId,
        mode,
        conflictPolicy,
        fileChanges,
        deletedMessageIds,
        actor,
        metadata: {
          conflicts: conflicts.length,
          ...(input.approvalRequestId
            ? { approvalRequestId: input.approvalRequestId }
            : {}),
        },
      });

      return {
        projectId: input.projectId,
        conversationId: input.conversationId,
        mode,
        targetMessageId: input.targetMessageId,
        restoredCheckpointId,
        safetyCheckpointId,
        deletedMessageIds,
        clearedAgentSessions,
        fileChanges,
        conflicts,
        actor,
        approvalRequestId: input.approvalRequestId ?? null,
      };
    });
  }

  async function restoreFiles(input: {
    project: ProjectRecord;
    targetCheckpoint: DbProjectCheckpointRow;
    targetManifest: CheckpointManifest;
    targetBlobSources: VerifiedBlobSources;
    conflictPolicy: RollbackConflictPolicy;
    safetyCheckpointId: string;
    currentManifest?: CheckpointManifest | null;
  }): Promise<RestoreFilesResult> {
    const currentManifest = input.currentManifest
      ?? await snapshotTransient(input.project, input.targetManifest);
    const baseline = await selectBaselineManifest(input.project.id, input.targetCheckpoint);
    const maps = makeFileMaps(input.targetManifest, currentManifest, baseline);
    const root = resolveProjectDir(options.projectsRoot, input.project.id, input.project.metadata);
    const rootReal = await realpath(root).catch(() => root);
    const pathPreflight = await detectRestorePathBlockers(root, rootReal, maps);
    const allConflicts = mergeConflicts(detectConflicts(maps), pathPreflight.conflicts);
    if (allConflicts.length > 0 && input.conflictPolicy === 'fail') {
      throw new ProjectCheckpointConflictError(allConflicts, input.safetyCheckpointId);
    }
    if (pathPreflight.conflicts.length > 0 && input.conflictPolicy === 'overwrite') {
      throw new ProjectCheckpointConflictError(allConflicts, input.safetyCheckpointId);
    }
    const conflictPaths = new Set(allConflicts.map((item) => item.path));
    const targetMap = maps.target;
    const currentMap = maps.current;
    const paths = new Set([...targetMap.keys(), ...currentMap.keys()]);
    const fileChanges = emptyFileChanges();
    const deleteDirs = new Set<string>();

    for (const relPath of [...paths].sort()) {
      if (
        input.conflictPolicy === 'keep_current' &&
        (conflictPaths.has(relPath) || pathPreflight.skipPaths.has(relPath))
      ) {
        continue;
      }
      const target = targetMap.get(relPath) ?? null;
      const current = currentMap.get(relPath) ?? null;
      if (target && current && target.hash === current.hash) {
        fileChanges.unchanged += 1;
        continue;
      }
      if (target) {
        const absolute = await resolveSafeProjectPath(root, rootReal, target.path);
        await mkdir(path.dirname(absolute), { recursive: true });
        const source = input.targetBlobSources.get(target.path);
        if (!source) {
          throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'checkpoint blob unavailable');
        }
        const temp = `${absolute}.readable-studio-restore-${randomUUID()}.tmp`;
        await copyFile(source, temp);
        await rename(temp, absolute);
        if (current) fileChanges.modified += 1;
        else fileChanges.added += 1;
      } else if (current) {
        const absolute = await resolveSafeProjectPath(root, rootReal, current.path);
        await unlink(absolute).catch((error: NodeJS.ErrnoException) => {
          if (error?.code !== 'ENOENT') throw error;
        });
        deleteDirs.add(path.dirname(absolute));
        fileChanges.deleted += 1;
      }
    }

    await removeEmptyDirs([...deleteDirs], rootReal);
    return {
      fileChanges,
      conflicts: allConflicts,
    };
  }

  async function snapshotProject(
    project: ProjectRecord,
    metadata: Omit<CheckpointManifest, 'schemaVersion' | 'rootPathHash' | 'files' | 'excluded'>,
    snapshotOptions: SnapshotOptions = {},
  ): Promise<SnapshotResult> {
    const root = resolveProjectDir(options.projectsRoot, project.id, project.metadata);
    const rootReal = await realpath(root).catch(() => root);
    const files: SnapshotFileEntry[] = [];
    const excluded: SnapshotExcludedEntry[] = [];
    await walkProject(
      root,
      '',
      files,
      excluded,
      snapshotOptions.blobWriter ? { blobWriter: snapshotOptions.blobWriter } : {},
    );
    files.sort((a, b) => a.path.localeCompare(b.path));
    excluded.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: CheckpointManifest = {
      schemaVersion: 1,
      ...metadata,
      rootPathHash: prefixedHash(rootReal),
      files,
      excluded,
    };
    const snapshot = {
      manifest,
      manifestHash: prefixedHash(JSON.stringify(manifest, null, 2)),
      manifestPath: path.join(checkpointDir(project.id, metadata.checkpointId), 'manifest.json'),
      totalBytes: files.reduce((sum, item) => sum + item.size, 0),
    };
    if (snapshotOptions.persistManifest !== false) await writeSnapshotManifest(snapshot);
    return snapshot;
  }

  async function writeSnapshotManifest(snapshot: SnapshotResult): Promise<void> {
    await mkdir(path.dirname(snapshot.manifestPath), { recursive: true });
    const temp = `${snapshot.manifestPath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(snapshot.manifest, null, 2), 'utf8');
    await rename(temp, snapshot.manifestPath);
  }

  async function snapshotTransient(
    project: ProjectRecord,
    source: CheckpointManifest,
  ): Promise<CheckpointManifest> {
    const checkpointId = `transient-${randomUUID()}`;
    const root = resolveProjectDir(options.projectsRoot, project.id, project.metadata);
    const rootReal = await realpath(root).catch(() => root);
    const files: SnapshotFileEntry[] = [];
    const excluded: SnapshotExcludedEntry[] = [];
    await walkProject(root, '', files, excluded, { writeBlobs: false });
    files.sort((a, b) => a.path.localeCompare(b.path));
    excluded.sort((a, b) => a.path.localeCompare(b.path));
    return {
      schemaVersion: 1,
      checkpointId,
      projectId: project.id,
      conversationId: source.conversationId,
      messageId: source.messageId,
      runId: source.runId,
      kind: 'manual',
      createdAt: Date.now(),
      rootPathHash: prefixedHash(rootReal),
      files,
      excluded,
    };
  }

  async function walkProject(
    absoluteDir: string,
    relDir: string,
    files: SnapshotFileEntry[],
    excluded: SnapshotExcludedEntry[],
    optionsOverride: {
      writeBlobs?: boolean;
      blobWriter?: (blob: string, buffer: Buffer) => Promise<void>;
    } = {},
  ): Promise<void> {
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        excluded.push({ path: relPath, reason: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) {
          excluded.push({ path: relPath, reason: skipReasonForEntry(entry.name, true) });
          continue;
        }
        await walkProject(
          path.join(absoluteDir, entry.name),
          relPath,
          files,
          excluded,
          optionsOverride,
        );
        continue;
      }
      if (!entry.isFile()) {
        excluded.push({ path: relPath, reason: 'special_file' });
        continue;
      }
      if (shouldSkipFile(entry.name)) {
        excluded.push({ path: relPath, reason: skipReasonForEntry(entry.name, false) });
        continue;
      }
      const absolute = path.join(absoluteDir, entry.name);
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        excluded.push({ path: relPath, reason: 'read_error' });
        continue;
      }
      if (!info.isFile()) {
        excluded.push({ path: relPath, reason: info.isSymbolicLink() ? 'symlink' : 'special_file' });
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        excluded.push({ path: relPath, reason: 'oversized_file' });
        continue;
      }
      const buffer = await readFile(absolute);
      const hash = prefixedHash(buffer);
      const blob = blobRelativePath(hash);
      if (optionsOverride.writeBlobs !== false) {
        await (optionsOverride.blobWriter ?? writeBlob)(blob, buffer);
      }
      files.push({
        path: relPath.replace(/\\/g, '/'),
        kind: 'file',
        size: info.size,
        mtimeMs: Math.round(info.mtimeMs),
        mode: info.mode,
        hash,
        blob,
      });
    }
  }

  async function writeBlob(blob: string, buffer: Buffer): Promise<void> {
    const target = blobAbsolutePath(blob);
    try {
      await stat(target);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, buffer);
    await rename(temp, target).catch(async (error: NodeJS.ErrnoException) => {
      await rm(temp, { force: true }).catch(() => undefined);
      if (error?.code === 'EEXIST') return;
      throw error;
    });
  }

  async function writeStagedBlob(stagingDir: string, blob: string, buffer: Buffer): Promise<void> {
    const target = path.join(stagingDir, blob);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, buffer);
  }

  async function publishStagedBlobs(manifest: CheckpointManifest, stagingDir: string): Promise<void> {
    for (const blob of new Set(manifest.files.map((file) => file.blob))) {
      const buffer = await readFile(path.join(stagingDir, blob));
      if (blobRelativePath(prefixedHash(buffer)) !== blob) {
        throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'staged checkpoint blob hash mismatch');
      }
      await writeBlob(blob, buffer);
    }
  }

  function checkpointDir(projectId: string, checkpointId: string): string {
    return path.join(
      options.dataDir,
      CHECKPOINTS_DIR_NAME,
      'projects',
      projectId,
      checkpointId,
    );
  }

  function blobAbsolutePath(blob: string): string {
    return path.join(options.dataDir, CHECKPOINTS_DIR_NAME, 'blobs', blob);
  }

  async function verifiedBlobAbsolutePath(file: SnapshotFileEntry): Promise<string> {
    if (file.blob !== blobRelativePath(file.hash)) {
      throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'checkpoint blob path mismatch');
    }
    const absolute = blobAbsolutePath(file.blob);
    let buffer: Buffer;
    try {
      buffer = await readFile(absolute);
    } catch {
      throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'checkpoint blob unavailable');
    }
    if (prefixedHash(buffer) !== file.hash) {
      throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'checkpoint blob hash mismatch');
    }
    return absolute;
  }

  async function preflightTargetBlobs(manifest: CheckpointManifest): Promise<VerifiedBlobSources> {
    const sources = new Map<string, string>();
    for (const file of manifest.files) {
      sources.set(file.path, await verifiedBlobAbsolutePath(file));
    }
    return sources;
  }

  async function assertManifestRootMatchesProject(
    project: ProjectRecord,
    manifest: CheckpointManifest,
  ): Promise<void> {
    const root = resolveProjectDir(options.projectsRoot, project.id, project.metadata);
    const rootReal = await realpath(root).catch(() => root);
    if (prefixedHash(rootReal) !== manifest.rootPathHash) {
      throw new ProjectCheckpointError(
        409,
        'CHECKPOINT_ROOT_MISMATCH',
        'checkpoint belongs to a different project root',
      );
    }
  }

  function requireProject(projectId: string): ProjectRecord {
    const project = getProject(options.db, projectId);
    if (!project) throw new ProjectCheckpointError(404, 'PROJECT_NOT_FOUND', 'project not found');
    return project;
  }

  function requireCheckpoint(projectId: string, checkpointId: string): DbProjectCheckpointRow {
    const checkpoint = getProjectCheckpoint(options.db, checkpointId);
    if (!checkpoint || checkpoint.projectId !== projectId) {
      throw new ProjectCheckpointError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
    }
    return checkpoint;
  }

  async function readManifest(checkpoint: DbProjectCheckpointRow): Promise<CheckpointManifest> {
    let text: string;
    let parsed: unknown;
    try {
      text = await readFile(checkpoint.manifestPath, 'utf8');
      parsed = JSON.parse(text);
    } catch {
      throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'checkpoint manifest unavailable');
    }
    if (prefixedHash(text) !== checkpoint.manifestHash) {
      throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'checkpoint manifest hash mismatch');
    }
    return validateManifest(parsed, checkpoint);
  }

  async function selectBaselineManifest(
    projectId: string,
    target: DbProjectCheckpointRow,
  ): Promise<{ row: DbProjectCheckpointRow; manifest: CheckpointManifest } | null> {
    const candidates = listProjectCheckpoints(options.db, projectId, {
      conversationId: target.conversationId,
    }).filter((candidate) =>
      candidate.id !== target.id &&
      candidate.kind !== 'before_restore' &&
      candidate.createdAt >= target.createdAt
    );
    for (const candidate of candidates) {
      try {
        return { row: candidate, manifest: await readManifest(candidate) };
      } catch {
        // Ignore stale or manually deleted manifests for baseline purposes.
      }
    }
    // No checkpoint is strictly newer than the target — this is the case when
    // rolling back the LATEST message. The agent's last recorded state for these
    // files IS the target checkpoint, so use it as the baseline instead of null.
    //
    // detectConflicts skips a file only when current === baseline; with the
    // target as baseline, every file the working tree has genuinely drifted from
    // the checkpoint is still flagged (the conflict set is identical to the null
    // baseline), so no real data-loss warning is masked. The difference is that
    // each conflict now carries the target's recorded content as its expected
    // baseline rather than a null reference point, and consumers no longer have
    // to special-case a missing baseline for the most-recent message.
    try {
      return { row: target, manifest: await readManifest(target) };
    } catch {
      return null;
    }
  }

  return {
    captureCheckpoint,
    listCheckpoints,
    getCheckpoint,
    diffCheckpoint,
    prepareAgentRollback,
    rollback,
  };
}

function validateManifest(value: unknown, checkpoint: DbProjectCheckpointRow): CheckpointManifest {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (
    !raw ||
    raw.schemaVersion !== 1 ||
    raw.checkpointId !== checkpoint.id ||
    raw.projectId !== checkpoint.projectId ||
    nullableString(raw.conversationId) !== checkpoint.conversationId ||
    nullableString(raw.messageId) !== checkpoint.messageId ||
    nullableString(raw.runId) !== checkpoint.runId ||
    raw.kind !== checkpoint.kind ||
    raw.rootPathHash !== checkpoint.rootPathHash
  ) {
    throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'checkpoint manifest invalid');
  }
  const files = validateManifestFiles(raw.files);
  const excluded = Array.isArray(raw.excluded)
    ? raw.excluded.map(validateExcludedEntry).filter(Boolean) as SnapshotExcludedEntry[]
    : [];
  return {
    schemaVersion: 1,
    checkpointId: checkpoint.id,
    projectId: checkpoint.projectId,
    conversationId: checkpoint.conversationId,
    messageId: checkpoint.messageId,
    runId: checkpoint.runId,
    kind: checkpoint.kind,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : checkpoint.createdAt,
    rootPathHash: checkpoint.rootPathHash,
    files,
    excluded,
  };
}

function assertCheckpointMatchesRollbackTarget(
  checkpoint: DbProjectCheckpointRow,
  target: { conversationId: string; targetMessageId: string },
): void {
  if (checkpoint.conversationId !== target.conversationId) {
    throw new ProjectCheckpointError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
  }
  if (checkpoint.messageId !== target.targetMessageId) {
    throw new ProjectCheckpointError(
      400,
      'CHECKPOINT_MESSAGE_MISMATCH',
      'checkpoint does not belong to target message',
    );
  }
}

function validateManifestFiles(value: unknown): SnapshotFileEntry[] {
  if (!Array.isArray(value)) {
    throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'checkpoint manifest invalid');
  }
  return value.map((item) => {
    const file = validateManifestFile(item);
    if (!file) {
      throw new ProjectCheckpointError(410, 'CHECKPOINT_UNAVAILABLE', 'checkpoint manifest invalid');
    }
    return file;
  });
}

function validateManifestFile(value: unknown): SnapshotFileEntry | null {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!raw || typeof raw.path !== 'string' || typeof raw.hash !== 'string' || typeof raw.blob !== 'string') {
    return null;
  }
  if (!isCheckpointRelPath(raw.path)) return null;
  if (!isCheckpointHash(raw.hash)) return null;
  if (raw.blob !== blobRelativePath(raw.hash)) return null;
  return {
    path: raw.path,
    kind: 'file',
    size: typeof raw.size === 'number' ? raw.size : 0,
    mtimeMs: typeof raw.mtimeMs === 'number' ? raw.mtimeMs : 0,
    mode: typeof raw.mode === 'number' ? raw.mode : 0,
    hash: raw.hash,
    blob: raw.blob,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function validateExcludedEntry(value: unknown): SnapshotExcludedEntry | null {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!raw || typeof raw.path !== 'string' || typeof raw.reason !== 'string') return null;
  if (!isCheckpointRelPath(raw.path)) return null;
  return {
    path: raw.path,
    reason: normalizeExcludedReason(raw.reason),
  };
}

function normalizeCheckpointKind(value: unknown): ProjectCheckpointKind {
  return value === 'before_run' ||
    value === 'after_run_unfinalized' ||
    value === 'after_message' ||
    value === 'before_restore' ||
    value === 'manual'
    ? value
    : 'manual';
}

function normalizeRollbackMode(value: unknown): RollbackMode {
  if (value === 'files_only' || value === 'chat_only' || value === 'files_and_chat') {
    return value;
  }
  throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'invalid rollback mode');
}

function normalizeRollbackConflictPolicy(value: unknown): RollbackConflictPolicy {
  if (value === 'fail' || value === 'keep_current' || value === 'overwrite') {
    return value;
  }
  throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'invalid conflictPolicy');
}

function normalizeExcludedReason(value: string): SnapshotExcludedEntry['reason'] {
  return value === 'ignored_dir' ||
    value === 'dot_entry' ||
    value === 'transient' ||
    value === 'symlink' ||
    value === 'special_file' ||
    value === 'oversized_file' ||
    value === 'read_error'
    ? value
    : 'read_error';
}

function makeFileMaps(
  target: CheckpointManifest,
  current: CheckpointManifest,
  baseline: { row: DbProjectCheckpointRow; manifest: CheckpointManifest } | null,
): FileMaps {
  return {
    target: new Map(target.files.map((item) => [item.path, item])),
    current: new Map(current.files.map((item) => [item.path, item])),
    baseline: baseline ? new Map(baseline.manifest.files.map((item) => [item.path, item])) : null,
  };
}

function diffFileMaps(maps: FileMaps): ProjectCheckpointFileDelta[] {
  const paths = new Set([...maps.target.keys(), ...maps.current.keys()]);
  return [...paths].sort().map((relPath) => {
    const current = maps.current.get(relPath) ?? null;
    const target = maps.target.get(relPath) ?? null;
    const status: ProjectCheckpointFileDelta['status'] =
      current && target
        ? (current.hash === target.hash ? 'unchanged' : 'modified')
        : current
          ? 'added'
          : 'deleted';
    return {
      path: relPath,
      status,
      fromHash: current?.hash ?? null,
      toHash: target?.hash ?? null,
      fromSize: current?.size ?? null,
      toSize: target?.size ?? null,
    };
  });
}

function manifestRevision(manifest: CheckpointManifest): string {
  return createHash('sha256').update(JSON.stringify({
    rootPathHash: manifest.rootPathHash,
    files: manifest.files
      .map(({ path: filePath, hash }) => ({ path: filePath, hash }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    excluded: manifest.excluded
      .map(({ path: excludedPath, reason }) => ({ path: excludedPath, reason }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason)),
  })).digest('hex');
}

function countFileChanges(files: ProjectCheckpointFileDelta[]): RollbackFileChangeCounts {
  const counts = emptyFileChanges();
  for (const file of files) {
    if (file.status === 'added') counts.deleted += 1;
    else if (file.status === 'deleted') counts.added += 1;
    else counts[file.status] += 1;
  }
  return counts;
}

function detectConflicts(maps: FileMaps): ProjectCheckpointConflict[] {
  const conflicts: ProjectCheckpointConflict[] = [];
  const affectedPaths = diffFileMaps(maps)
    .filter((item) => item.status !== 'unchanged')
    .map((item) => item.path);
  for (const relPath of affectedPaths) {
    const expected = maps.baseline?.get(relPath) ?? null;
    const current = maps.current.get(relPath) ?? null;
    const target = maps.target.get(relPath) ?? null;
    if (maps.baseline && (expected?.hash ?? null) === (current?.hash ?? null)) continue;
    conflicts.push({
      path: relPath,
      reason: current ? 'current_changed_since_checkpoint' : 'current_deleted_since_checkpoint',
      currentHash: current?.hash ?? null,
      expectedHash: expected?.hash ?? null,
      targetHash: target?.hash ?? null,
    });
  }
  return conflicts;
}

async function detectRestorePathBlockers(
  root: string,
  rootReal: string,
  maps: FileMaps,
): Promise<RestorePathPreflight> {
  const conflicts: ProjectCheckpointConflict[] = [];
  const skipPaths = new Set<string>();
  const seen = new Set<string>();
  const addConflict = (
    pathValue: string,
    reason: ProjectCheckpointConflict['reason'],
  ) => {
    const key = `${pathValue}\0${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push({
      path: pathValue,
      reason,
      currentHash: maps.current.get(pathValue)?.hash ?? null,
      expectedHash: maps.baseline?.get(pathValue)?.hash ?? null,
      targetHash: maps.target.get(pathValue)?.hash ?? null,
    });
  };
  const addCurrentSubtreeToSkip = (relPath: string) => {
    skipPaths.add(relPath);
    const prefix = `${relPath}/`;
    for (const currentPath of maps.current.keys()) {
      if (currentPath.startsWith(prefix)) skipPaths.add(currentPath);
    }
  };

  for (const target of maps.target.values()) {
    let absolute: string;
    try {
      absolute = await resolveSafeProjectPath(root, rootReal, target.path);
    } catch {
      addConflict(target.path, 'path_escapes_project');
      skipPaths.add(target.path);
      continue;
    }

    const parts = target.path.split('/');
    let parentBlocked = false;
    for (let index = 1; index < parts.length; index += 1) {
      const parentPath = parts.slice(0, index).join('/');
      let parentAbsolute: string;
      try {
        parentAbsolute = await resolveSafeProjectPath(root, rootReal, parentPath);
      } catch {
        addConflict(parentPath, 'path_escapes_project');
        skipPaths.add(parentPath);
        skipPaths.add(target.path);
        parentBlocked = true;
        break;
      }
      const parentInfo = await lstatIfExists(parentAbsolute);
      if (!parentInfo) break;
      if (parentInfo.isDirectory()) continue;
      addConflict(parentPath, parentInfo.isFile() ? 'target_path_blocked' : 'unsupported_file_type');
      skipPaths.add(parentPath);
      skipPaths.add(target.path);
      parentBlocked = true;
      break;
    }
    if (parentBlocked) continue;

    const targetInfo = await lstatIfExists(absolute);
    if (!targetInfo) continue;
    if (targetInfo.isDirectory()) {
      addConflict(target.path, 'target_path_blocked');
      addCurrentSubtreeToSkip(target.path);
      continue;
    }
    if (!targetInfo.isFile()) {
      addConflict(target.path, 'unsupported_file_type');
      skipPaths.add(target.path);
    }
  }

  for (const current of maps.current.values()) {
    if (maps.target.has(current.path)) continue;
    let absolute: string;
    try {
      absolute = await resolveSafeProjectPath(root, rootReal, current.path);
    } catch {
      addConflict(current.path, 'path_escapes_project');
      skipPaths.add(current.path);
      continue;
    }
    const currentInfo = await lstatIfExists(absolute);
    if (!currentInfo) continue;
    if (currentInfo.isFile()) continue;
    addConflict(current.path, currentInfo.isDirectory() ? 'target_path_blocked' : 'unsupported_file_type');
    addCurrentSubtreeToSkip(current.path);
  }

  return { conflicts, skipPaths };
}

async function lstatIfExists(absolute: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function mergeConflicts(...groups: ProjectCheckpointConflict[][]): ProjectCheckpointConflict[] {
  const merged: ProjectCheckpointConflict[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const conflict of group) {
      const key = `${conflict.path}\0${conflict.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(conflict);
    }
  }
  return merged;
}

async function resolveSafeProjectPath(root: string, rootReal: string, relPath: string): Promise<string> {
  if (!isCheckpointRelPath(relPath)) {
    throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'invalid checkpoint path');
  }
  const target = path.resolve(root, ...relPath.split('/'));
  const normalizedRoot = path.resolve(root);
  if (!target.startsWith(normalizedRoot + path.sep) && target !== normalizedRoot) {
    throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'checkpoint path escapes project');
  }
  const existingPrefix = await resolveExistingPrefix(target);
  if (!existingPrefix.startsWith(rootReal + path.sep) && existingPrefix !== rootReal) {
    throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'checkpoint path escapes project');
  }
  return target;
}

async function resolveExistingPrefix(target: string): Promise<string> {
  const parts = path.resolve(target).split(path.sep);
  for (let i = parts.length; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      return await realpath(prefix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
  return target;
}

async function removeEmptyDirs(dirs: string[], rootReal: string): Promise<void> {
  const sorted = [...new Set(dirs)].sort((a, b) => b.length - a.length);
  for (const dir of sorted) {
    const real = await realpath(dir).catch(() => null);
    if (!real || real === rootReal || !real.startsWith(rootReal + path.sep)) continue;
    await rm(real, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT' && error?.code !== 'EPERM') {
        throw error;
      }
    });
  }
}

function shouldSkipDirectory(name: string): boolean {
  if (name === '.live-artifacts') return false;
  const lower = name.toLowerCase();
  return isIgnoredProjectDirName(name) ||
    TRANSIENT_DOT_DIRS.has(lower) ||
    name.startsWith('.');
}

function shouldSkipFile(name: string): boolean {
  const lower = name.toLowerCase();
  return TRANSIENT_DOT_FILES.has(lower) || name.startsWith('.');
}

function skipReasonForEntry(name: string, isDirectory: boolean): SnapshotExcludedEntry['reason'] {
  const lower = name.toLowerCase();
  if (TRANSIENT_DOT_DIRS.has(lower) || TRANSIENT_DOT_FILES.has(lower)) return 'transient';
  if (isDirectory && isIgnoredProjectDirName(name)) return 'ignored_dir';
  if (name.startsWith('.')) return 'dot_entry';
  return 'ignored_dir';
}

function isCheckpointRelPath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/').filter(Boolean);
  return parts.length > 0 && parts.every((part) => part !== '.' && part !== '..');
}

function isCheckpointHash(value: string): boolean {
  return new RegExp(`^${BLOB_ALGORITHM}:[a-f0-9]{64}$`).test(value);
}

function prefixedHash(input: string | Buffer): string {
  return `${BLOB_ALGORITHM}:${createHash(BLOB_ALGORITHM).update(input).digest('hex')}`;
}

function blobRelativePath(hash: string): string {
  const digest = hash.startsWith(`${BLOB_ALGORITHM}:`)
    ? hash.slice(`${BLOB_ALGORITHM}:`.length)
    : hash;
  return path.join(BLOB_ALGORITHM, digest.slice(0, 2), digest);
}

function emptyFileChanges(): RollbackFileChangeCounts {
  return {
    added: 0,
    modified: 0,
    deleted: 0,
    unchanged: 0,
  };
}

function toSummary(row: DbProjectCheckpointRow): ProjectCheckpointSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    runId: row.runId,
    kind: row.kind,
    createdAt: row.createdAt,
    rootPathHash: row.rootPathHash,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    manifestHash: row.manifestHash,
    restoreModes: row.restoreModes,
  };
}
