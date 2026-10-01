import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const MARKER = 'data-import.json';
const hash = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Decision = { state: string; sourceRoot?: string; sourceData?: string; requestedAt?: string; error?: string; rowCounts?: Record<string, number> };
export interface DataImportOptions {
  /** Daemon data directory, NOT the namespace or installation directory. */
  dataRoot: string;
  /** New extracted application directory. */
  appRoot?: string;
  /** Actual active payload resources, which may be under .app/current. */
  resourceRoot?: string;
  /** Wire to the packaged host's graceful relaunch; never just kill the daemon. */
  onRestartRequested?: () => void | Promise<void>;
  /** Test seam; production queries actual Windows process executable paths. */
  listProcessImages?: () => Promise<string[]>;
  afterCopyFile?: (relativePath: string) => void | Promise<void>;
}
export interface DataImportResult {
  status: 'none' | 'done' | 'failed';
  error?: string;
  rowCounts?: Record<string, number>;
  files?: number;
  bytes?: number;
  /** Close on host shutdown. No watcher is created without onRestartRequested. */
  stopWatching: () => void;
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function readDecision(root: string): Promise<Decision | null> {
  try { return JSON.parse(await readFile(path.join(root, MARKER), 'utf8')) as Decision; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function saveDecision(root: string, decision: Decision): Promise<void> {
  const target = path.join(root, MARKER);
  await writeFile(`${target}.tmp`, JSON.stringify(decision, null, 2));
  await rename(`${target}.tmp`, target);
}

/** Unlike a stamp/lock scan this also sees <=1.2.1, which never wrote data.lock.
 * Failure to enumerate processes is a refusal, never evidence of quiescence. */
async function processImages(): Promise<string[]> {
  if (process.platform !== 'win32') throw new Error('Windows process inspection is required');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath,ProcessId | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const raw = JSON.parse(stdout) as { Name: string; ExecutablePath: string | null; ProcessId: number } | { Name: string; ExecutablePath: string | null; ProcessId: number }[];
  const rows = Array.isArray(raw) ? raw : [raw];
  if (rows.some(row => /readable.*studio/i.test(row.Name) && !row.ExecutablePath)) throw new Error('Cannot inspect a running Readable Studio process');
  return rows.flatMap(row => row.ExecutablePath && row.ProcessId !== process.pid ? [row.ExecutablePath] : []);
}

async function digest(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}
type Inventory = Record<string, { bytes: number; sha256: string }>;
async function inventory(root: string, directories?: string[]): Promise<Inventory> {
  const result: Inventory = {};
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(root, absolute);
      // Only daemon-owned data is imported. Namespace Chromium/log/runtime/cache
      // siblings are deliberately not traversed. Agent scan is regenerated.
      if (rel === MARKER || rel === 'agent-scan.json' || rel === 'data.lock' || rel === 'cache' || rel === 'user-data' || rel === 'runtime' || rel === 'logs') continue;
      if (entry.isSymbolicLink()) throw new Error(`Linked data is not imported: ${rel}`);
      if (entry.isDirectory()) { directories?.push(rel); await visit(absolute); }
      else if (entry.isFile()) result[rel] = { bytes: (await lstat(absolute)).size, sha256: await digest(absolute) };
      else throw new Error(`Unsupported data file: ${rel}`);
    }
  }
  await visit(root);
  return result;
}
const isDatabase = (rel: string) => /^app\.sqlite(?:-wal|-shm)?$/.test(rel);
function rowCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [String(row.name), Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(String(row.name))}`).get()!.n)]));
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function assertEmpty(file: string): void {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
    if (!table || Number(db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n) !== 0) throw new Error('The destination already contains projects or an unrecognized database');
  } finally { db.close(); }
}

/** Rewrites machine-consumed paths only, preserving external project locations.
 * Old extract prefixes are authenticated by each checkpoint's manifest hash and
 * physical-root hash before upgrading its binding to schema 2 / project id. */
async function relocate(db: DatabaseSync, stage: string, sourceData: string, destination: string, sourceRoot: string, appRoot: string, resourceRoot: string): Promise<void> {
  const tables = new Set(Object.keys(rowCounts(db)));
  const dataAliases = new Set([sourceData]);
  if (tables.has('project_checkpoints')) {
    for (const row of db.prepare('SELECT * FROM project_checkpoints').all()) {
      const id = String(row.id); const projectId = String(row.project_id);
      if ([id, projectId].some(value => !value || value === '.' || value === '..' || path.basename(value) !== value)) throw new Error('Invalid checkpoint identity');
      const relative = path.join('checkpoints', 'projects', projectId, id, 'manifest.json');
      const file = path.join(stage, relative);
      const text = await readFile(file, 'utf8');
      if (hash(text) !== row.manifest_hash) throw new Error(`Checkpoint manifest hash mismatch: ${id}`);
      const manifest = JSON.parse(text) as { schemaVersion: number; projectId: string; checkpointId: string; rootPathHash: string; files: Array<{ blob: string; hash: string }> };
      if (manifest.projectId !== projectId || manifest.checkpointId !== id || manifest.rootPathHash !== row.root_path_hash) throw new Error(`Checkpoint identity mismatch: ${id}`);
      for (const entry of manifest.files) {
        const blobRoot = path.join(stage, 'checkpoints', 'blobs');
        const blob = path.resolve(blobRoot, entry.blob);
        if (!inside(blobRoot, blob) || `sha256:${await digest(blob)}` !== entry.hash) throw new Error(`Checkpoint blob mismatch: ${id}`);
      }
      const stored = String(row.manifest_path);
      const suffix = path.join('checkpoints', 'projects', projectId, id, 'manifest.json');
      const oldRoot = path.isAbsolute(stored) && stored.toLowerCase().endsWith(suffix.toLowerCase()) ? stored.slice(0, -suffix.length).replace(/[\\/]+$/, '') : sourceData;
      if (manifest.schemaVersion === 1) {
        const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
        if (!project) throw new Error(`Missing checkpoint project: ${projectId}`);
        const metadata = JSON.parse(String(project.metadata_json ?? project.metadata ?? '{}')) as { baseDir?: string };
        const physical = metadata.baseDir && path.isAbsolute(metadata.baseDir) ? metadata.baseDir : path.join(oldRoot, 'projects', projectId);
        const canonicalPhysical = metadata.baseDir ? await realpath(physical) : physical;
        if (hash(canonicalPhysical) !== manifest.rootPathHash) throw new Error(`Legacy checkpoint root mismatch: ${id}`);
        manifest.schemaVersion = 2;
        manifest.rootPathHash = hash(`project:${projectId}`);
      } else if (manifest.schemaVersion !== 2 || manifest.rootPathHash !== hash(`project:${projectId}`)) throw new Error(`Unsupported checkpoint binding: ${id}`);
      dataAliases.add(oldRoot);
      const rewritten = JSON.stringify(manifest, null, 2);
      await writeFile(file, rewritten);
      db.prepare('UPDATE project_checkpoints SET manifest_path=?, root_path_hash=?, manifest_hash=? WHERE id=?').run(relative, manifest.rootPathHash, hash(rewritten), id);
    }
  }
  const mappings = [...dataAliases].map(root => [root, destination] as const);
  mappings.push([sourceRoot, appRoot]);
  mappings.unshift([path.join(sourceRoot, 'resources', 'readable-studio'), resourceRoot]);
  // Archives can retain absolute paths to the original extract rather than the
  // directory containing this copy. Only infer its app root from the fixed layout.
  for (const alias of dataAliases) {
    const match = /^(.*)[\\/]ReadableStudioData[\\/]namespaces[\\/][^\\/]+[\\/]data$/i.exec(alias);
    if (match) {
      mappings.push([match[1]!, appRoot]);
      mappings.unshift([path.join(match[1]!, 'resources', 'readable-studio'), resourceRoot]);
    }
  }
  function rewrite(value: unknown): unknown {
    if (typeof value === 'string') {
      for (const [from, to] of mappings) if (path.isAbsolute(value) && inside(from, value)) return path.join(to, path.relative(from, value));
      return value;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]));
    return value;
  }
  // Explicit machine-consumed columns; never search/replace conversation prose.
  const fields: Record<string, string[]> = {
    projects: ['metadata_json'], agent_sessions: ['session_id'], message_snapshots: ['run_context_json'],
    installed_plugins: ['fs_path', 'source', 'resolved_source'], plugin_marketplaces: ['source'],
  };
  for (const [table, wanted] of Object.entries(fields)) {
    if (!tables.has(table)) continue;
    const columns = new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => String(row.name)));
    for (const column of wanted.filter(c => columns.has(c))) {
      for (const row of db.prepare(`SELECT *, rowid AS import_rowid, ${quote(column)} AS value FROM ${quote(table)}`).all()) {
        if (typeof row.value !== 'string') continue;
        let next: string;
        if (column.endsWith('_json')) next = JSON.stringify(rewrite(JSON.parse(row.value)));
        else next = String(rewrite(row.value));
        if (table === 'agent_sessions' && path.isAbsolute(next)) {
          // Databricks owns a per-conversation hash directory; direct Pi owns
          // <project>/.pi/sessions. Relative pointers must use THAT root, not
          // the common sessions parent (which would duplicate the hash).
          const databricksRoot = path.join(destination, 'databricks', 'sessions');
          if (row.agent_id === 'databricks' && inside(databricksRoot, next)) next = path.basename(next);
          else {
            const marker = `${path.sep}.pi${path.sep}sessions${path.sep}`;
            const index = next.indexOf(marker);
            if (index >= 0 && inside(destination, next)) next = next.slice(index + marker.length);
          }
        }
        if (next !== row.value) db.prepare(`UPDATE ${quote(table)} SET ${quote(column)}=? WHERE rowid=?`).run(next, row.import_rowid!);
      }
    }
  }
  const configPath = path.join(stage, 'app-config.json');
  if (await exists(configPath)) await writeFile(configPath, JSON.stringify(rewrite(JSON.parse(await readFile(configPath, 'utf8'))), null, 2));
  // Pi verifies its session header cwd on resume. Rebind JSON values in the
  // transcript, not just the database pointer, without changing event ordering.
  for (const rel of Object.keys(await inventory(stage)).filter(file => file.endsWith('.jsonl') && (file.startsWith(`databricks${path.sep}sessions${path.sep}`) || file.includes(`${path.sep}.pi${path.sep}sessions${path.sep}`)))) {
    const file = path.join(stage, rel);
    const content = await readFile(file, 'utf8');
    await writeFile(file, content.split('\n').map(line => line.trim() ? JSON.stringify(rewrite(JSON.parse(line))) : line).join('\n'));
  }
}

/** Run BEFORE Electron profile access, data locks, and daemon/web sidecars.
 * The old root is copied, never opened writable. Publication is a same-volume
 * rename with rollback; the empty root is retained as .import-empty. */
export async function runPendingDataImport(options: DataImportOptions): Promise<DataImportResult> {
  const dataRoot = path.resolve(options.dataRoot);
  const staging = `${dataRoot}.import-staging`;
  const scratch = `${dataRoot}.import-source`;
  const empty = `${dataRoot}.import-empty`;
  let watcher: FSWatcher | undefined;
  const finish = (result: Omit<DataImportResult, 'stopWatching'>): DataImportResult => {
    if (options.onRestartRequested) {
      let requested = false;
      watcher = watch(dataRoot, { persistent: false }, (_event, name) => {
        if (name?.toString() !== MARKER || requested) return;
        void readDecision(dataRoot).then(async decision => {
          if (decision?.state !== 'pending' || requested) return;
          requested = true;
          await options.onRestartRequested!();
        }).catch(error => { console.error('[data-import] restart request failed', error); });
      });
    }
    return { ...result, stopWatching: () => watcher?.close() };
  };
  // Recover interruption between the two renames, before anything can create a
  // blank app.sqlite in the missing destination.
  if (!(await exists(dataRoot)) && await exists(empty)) await rename(empty, dataRoot);
  await mkdir(dataRoot, { recursive: true });
  const decision = await readDecision(dataRoot);
  if (decision?.state !== 'pending') return finish({ status: 'none' });
  let movedEmpty = false;
  let published = false;
  let preparedStage = false;
  let preparedScratch = false;
  try {
    if (!decision.sourceRoot || !decision.sourceData) throw new Error('Import request has no source');
    const sourceRoot = await realpath(decision.sourceRoot);
    const sourceData = await realpath(decision.sourceData);
    const target = await realpath(dataRoot);
    if (!inside(sourceRoot, sourceData) || [target, staging, scratch, empty].some(owned => inside(sourceData, owned) || inside(owned, sourceData))) throw new Error('Source and destination overlap');
    const ensureStopped = async () => {
      if ((await (options.listProcessImages ?? processImages)()).some(image => inside(sourceRoot, path.resolve(image)))) throw new Error('SOURCE_RUNNING: 이전 버전이 실행 중입니다. 이전 버전을 닫은 뒤 다시 가져와 주세요.');
    };
    await ensureStopped();
    if (await exists(path.join(dataRoot, 'app.sqlite'))) assertEmpty(path.join(dataRoot, 'app.sqlite'));
    if (await exists(empty)) throw new Error(`Retained import destination already exists: ${empty}`);
    for (const dir of [staging, scratch]) {
      if (await exists(dir) && (await lstat(dir)).isSymbolicLink()) throw new Error('Import staging must not be a link');
      await rm(dir, { recursive: true, force: true }); await mkdir(dir);
      if (dir === staging) preparedStage = true;
      else preparedScratch = true;
    }
    const directories: string[] = [];
    const before = await inventory(sourceData, directories);
    for (const directory of directories) await mkdir(path.join(staging, directory), { recursive: true });
    const bytes = Object.values(before).reduce((sum, file) => sum + file.bytes, 0);
    const disk = await statfs(dataRoot);
    if (disk.bavail * disk.bsize < bytes * 2 + 16 * 1024 * 1024) throw new Error(`가져오기에 필요한 여유 공간이 부족합니다 (${bytes * 2} bytes).`);
    for (const [rel] of Object.entries(before)) {
      const targetFile = path.join(isDatabase(rel) ? scratch : staging, rel);
      await mkdir(path.dirname(targetFile), { recursive: true });
      await copyFile(path.join(sourceData, rel), targetFile);
      await options.afterCopyFile?.(rel);
    }
    const source = new DatabaseSync(path.join(scratch, 'app.sqlite'), { readOnly: true });
    let counts: Record<string, number>;
    try {
      counts = rowCounts(source);
      if (!counts.projects) throw new Error('The source contains no projects');
      const identity = Number(source.prepare('PRAGMA application_id').get()!.application_id);
      if (identity !== 0x52535444 && identity !== 0) throw new Error('Unrecognized source database');
      source.prepare('VACUUM INTO ?').run(path.join(staging, 'app.sqlite'));
    } finally { source.close(); }
    const copied = await inventory(staging);
    const filesOnly = (value: Inventory) => Object.fromEntries(Object.entries(value).filter(([rel]) => !isDatabase(rel)).sort(([a], [b]) => a.localeCompare(b)));
    if (!same(filesOnly(before), filesOnly(copied))) throw new Error('Copied file inventory differs');
    const targetDb = new DatabaseSync(path.join(staging, 'app.sqlite'));
    try {
      if (!same(counts, rowCounts(targetDb))) throw new Error('Database row counts differ');
      const appRoot = options.appRoot ?? path.dirname(path.dirname(path.dirname(path.dirname(dataRoot))));
      await relocate(targetDb, staging, sourceData, dataRoot, sourceRoot, appRoot, options.resourceRoot ?? path.join(appRoot, 'resources', 'readable-studio'));
      if (!same(counts, rowCounts(targetDb))) throw new Error('Relocation changed database row counts');
    } finally { targetDb.close(); }
    await ensureStopped();
    if (!same(before, await inventory(sourceData))) throw new Error('Source changed during import');
    if (await exists(path.join(dataRoot, 'app.sqlite'))) assertEmpty(path.join(dataRoot, 'app.sqlite'));
    await saveDecision(staging, { ...decision, state: 'done', rowCounts: counts });
    await rm(scratch, { recursive: true, force: true });
    await rename(dataRoot, empty); movedEmpty = true;
    await rename(staging, dataRoot); published = true;
    await writeFile(path.join(sourceRoot, 'imported.json'), JSON.stringify({ message: `이 폴더의 작업 내역은 ${options.appRoot ?? dataRoot}로 가져갔습니다`, destination: dataRoot, importedAt: new Date().toISOString() }, null, 2));
    return finish({ status: 'done', rowCounts: counts, files: Object.keys(filesOnly(before)).length, bytes });
  } catch (error) {
    // A failed tombstone/publication also restores the untouched empty generation.
    if (published) await rename(dataRoot, staging);
    if (movedEmpty) await rename(empty, dataRoot);
    if (preparedStage) await rm(staging, { recursive: true, force: true });
    if (preparedScratch) await rm(scratch, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    await saveDecision(dataRoot, { ...decision, state: 'failed', error: message });
    return finish({ status: 'failed', error: message });
  }
}
