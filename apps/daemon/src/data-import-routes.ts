import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listWindowsExecutableProcesses, processesInsideRoot, stopProcessesInsideRoot, type ExecutableProcess } from '@readable-studio/platform';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import type { DataImportCandidate, DataImportCandidatesResponse, DataImportSourceRunningError, DataImportState } from '@readable-studio/contracts';

const MARKER = 'data-import.json';
const OFFER_OWNER = `${process.pid}:${Date.now()}`;
/** The 1.3.3 release ZIP was built with this QA namespace instead of the
 * release one. Only this exact namespace is additionally probed; discovery is
 * not widened to arbitrary namespaces. */
const MISBUILT_NAMESPACE = 'au-rel133';
interface Probe { sourceRoot: string; sourceData: string; misbuilt?: boolean }
interface Decision { state: DataImportState; offeredBy?: string; sourceRoot?: string; sourceData?: string; error?: string; requestedAt?: string; restartRequested?: boolean }
export interface DataImportRouteOptions {
  dataRoot: string;
  /** Packaged host supplies READABLE_UPDATE_ROOT; fixed data layout is the fallback. */
  appRoot?: string;
  namespace?: string;
  /** Native process seams; the endpoint still authenticates the selected root. */
  listProcesses?: () => Promise<ExecutableProcess[]>;
  terminateProcess?: (target: ExecutableProcess) => Promise<void>;
}
function inside(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
async function decision(dataRoot: string): Promise<Decision | null> {
  try { return JSON.parse(await readFile(path.join(dataRoot, MARKER), 'utf8')) as Decision; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function record(dataRoot: string, value: Decision): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  const target = path.join(dataRoot, MARKER);
  await writeFile(`${target}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${target}.tmp`, target);
}

/** Never opens the original, including for probing. SQLite may create/change
 * SHM even with a read-only WAL connection, so all three files go to scratch. */
export async function inspectImportDatabase(file: string): Promise<{ projectCount: number; modifiedAt: string }> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size === 0) throw new Error('Empty database file');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'readable-import-probe-'));
  let db: Database.Database | undefined;
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      try { await copyFile(file + suffix, path.join(scratch, 'app.sqlite' + suffix)); }
      catch (error) { if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    }
    db = new Database(path.join(scratch, 'app.sqlite'), { readonly: true, fileMustExist: true });
    const identity = db.pragma('application_id', { simple: true });
    if (identity !== 0 && identity !== 0x52535444) throw new Error('Not a Readable Studio database');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
    if (identity === 0 && !db.prepare("SELECT name FROM sqlite_master WHERE name='conversations'").get()) throw new Error('Unrecognized legacy database');
    return { projectCount: rows.n, modifiedAt: metadata.mtime.toISOString() };
  } finally { db?.close(); await rm(scratch, { recursive: true, force: true }); }
}
function layout(options: DataImportRouteOptions): { appRoot: string; namespace: string } | null {
  const match = /^(.*)[\\/]ReadableStudioData[\\/]namespaces[\\/]([^\\/]+)[\\/]data$/i.exec(path.resolve(options.dataRoot));
  const appRoot = options.appRoot ?? process.env.READABLE_UPDATE_ROOT ?? match?.[1];
  const namespace = options.namespace ?? match?.[2];
  return appRoot && namespace ? { appRoot: path.resolve(appRoot), namespace } : null;
}
async function empty(dataRoot: string): Promise<boolean> {
  try { return (await inspectImportDatabase(path.join(dataRoot, 'app.sqlite'))).projectCount === 0; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
async function probesFor(appRoot: string, namespace: string): Promise<Probe[]> {
  const siblings = (await readdir(path.dirname(appRoot), { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink());
  if (siblings.length > 512) throw new Error('Too many sibling folders for bounded import discovery');
  const probes: Probe[] = siblings.map(entry => {
    const sourceRoot = path.join(path.dirname(appRoot), entry.name);
    return { sourceRoot, sourceData: path.join(sourceRoot, 'ReadableStudioData', 'namespaces', namespace, 'data') };
  });
  probes.push({ sourceRoot: appRoot, sourceData: path.join(appRoot, 'ReadableStudioData', 'data') },
    { sourceRoot: appRoot, sourceData: path.join(appRoot, '.readable-studio') });
  if (namespace.toLowerCase() !== MISBUILT_NAMESPACE) {
    for (const entry of siblings) {
      const sourceRoot = path.join(path.dirname(appRoot), entry.name);
      if (sourceRoot.toLowerCase() === appRoot.toLowerCase()) continue;
      probes.push({ sourceRoot, sourceData: path.join(sourceRoot, 'ReadableStudioData', 'namespaces', MISBUILT_NAMESPACE, 'data'), misbuilt: true });
    }
    // 1.3.3 work in THIS extract: the namespace folder is the source root, so
    // the running app under <appRoot>\app is never mistaken for the source.
    const sourceRoot = path.join(appRoot, 'ReadableStudioData', 'namespaces', MISBUILT_NAMESPACE);
    probes.push({ sourceRoot, sourceData: path.join(sourceRoot, 'data'), misbuilt: true });
  }
  return probes;
}
export async function discoverDataImports(options: DataImportRouteOptions, onlyMisbuilt = false): Promise<{ candidates: DataImportCandidate[]; warnings: string[] }> {
  const resolved = layout(options);
  if (!resolved) return { candidates: [], warnings: [] };
  const probes = (await probesFor(resolved.appRoot, resolved.namespace)).filter(probe => !onlyMisbuilt || probe.misbuilt);
  const candidates: DataImportCandidate[] = []; const warnings: string[] = [];
  const current = await realpath(options.dataRoot);
  for (const probe of probes) {
    try {
      if ((await lstat(probe.sourceData)).isSymbolicLink()) throw new Error('Linked data roots are not imported');
      const sourceData = await realpath(probe.sourceData);
      if (sourceData === current || inside(sourceData, current) || inside(current, sourceData)) continue;
      const sourceRoot = await realpath(probe.sourceRoot);
      if (!inside(sourceRoot, sourceData)) throw new Error('Data root escapes its extract folder');
      const info = await inspectImportDatabase(path.join(sourceData, 'app.sqlite'));
      if (info.projectCount > 0) candidates.push({ sourceRoot, sourceData, ...info });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${probe.sourceData}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  candidates.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) || a.sourceData.localeCompare(b.sourceData));
  return { candidates, warnings };
}
/** In-place 1.3.2->1.3.3 updates split work between the release namespace and
 * au-rel133. Never merged or offered over existing projects: reported only. */
async function splitNamespaceNotice(options: DataImportRouteOptions): Promise<string[]> {
  try {
    const found = await discoverDataImports(options, true);
    if (!found.candidates.length || await empty(options.dataRoot)) return [];
    return [...found.candidates.map(item => `SPLIT_NAMESPACE: ${item.sourceData}: 1.3.3에서 만든 작업 ${item.projectCount}개가 있지만 현재 폴더에 이미 작업이 있어 자동으로 가져오거나 합치지 않았습니다.`), ...found.warnings];
  } catch (error) { return [`SPLIT_NAMESPACE_CHECK_FAILED: ${error instanceof Error ? error.message : String(error)}`]; }
}

export function registerDataImportRoutes(app: Express, options: DataImportRouteOptions): void {
  // Serialize decision writes so concurrent renderer/CLI requests cannot select
  // different sources or race confirmation against cancellation.
  let serial: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = serial.then(fn, fn); serial = result.catch(() => undefined); return result;
  };
  const listProcesses = options.listProcesses ?? (() => listWindowsExecutableProcesses(/readable.*studio/i));
  app.get('/api/data-import/candidates', async (_req, res) => {
    try {
      const result = await locked(async (): Promise<DataImportCandidatesResponse> => {
        const previous = await decision(options.dataRoot);
        if (previous && (previous.state !== 'offered' || previous.offeredBy !== OFFER_OWNER)) {
          const runningSource = previous.state === 'failed' && previous.error?.startsWith('SOURCE_RUNNING') && previous.sourceRoot && previous.sourceData
            ? { sourceRoot: await realpath(previous.sourceRoot), sourceData: previous.sourceData, processes: processesInsideRoot(await realpath(previous.sourceRoot), await listProcesses()) }
            : undefined;
          const notice = previous.state === 'pending' || previous.state === 'failed' ? [] : await splitNamespaceNotice(options);
          return { state: previous.state === 'offered' ? 'unavailable' : previous.state, candidates: [], ...(previous.error ? { error: previous.error } : {}), ...(runningSource ? { runningSource } : {}), ...(notice.length ? { warnings: notice } : {}) };
        }
        if (!layout(options)) return { state: 'unavailable', candidates: [] };
        if (!(await empty(options.dataRoot))) {
          const notice = await splitNamespaceNotice(options);
          return { state: 'unavailable', candidates: [], ...(notice.length ? { warnings: notice } : {}) };
        }
        const found = await discoverDataImports(options);
        if (!found.candidates.length) return { state: 'unavailable', ...found };
        await record(options.dataRoot, { state: 'offered', offeredBy: OFFER_OWNER });
        return { state: 'offered', ...found };
      });
      res.json(result);
    } catch (error) { res.status(500).json({ error: `이전 작업 내역을 확인하지 못했습니다. ${error instanceof Error ? error.message : String(error)}` }); }
  });
  app.post('/api/data-import/request', async (req, res) => {
    try {
      const action = req.body?.action;
      if (action !== 'decline' && action !== 'restart' && (!['import', 'stop-source'].includes(action) || typeof req.body?.from !== 'string')) { res.status(400).json({ error: 'Invalid import request' }); return; }
      const result = await locked(async () => {
        const previous = await decision(options.dataRoot);
        if (previous?.state === 'done') throw new Error('이미 가져오기를 요청했습니다. 앱을 다시 시작해 주세요.');
        if (action === 'restart') {
          if (previous?.state !== 'pending') throw new Error('먼저 가져올 작업 폴더를 선택해 주세요.');
          await record(options.dataRoot, { ...previous, restartRequested: true });
          return { state: 'pending', restartRequired: true };
        }
        if (previous?.state === 'pending') {
          if (action !== 'decline') throw new Error('이미 가져오기를 요청했습니다. 앱을 다시 시작해 주세요.');
          await rm(path.join(options.dataRoot, MARKER));
          return { state: 'declined', restartRequired: false };
        }
        if (!(await empty(options.dataRoot))) throw new Error('현재 폴더에 작업이 있어 덮어쓰지 않았습니다.');
        if (action === 'decline') {
          await record(options.dataRoot, { state: 'declined' }); return { state: 'declined', restartRequired: false };
        }
        if (action === 'stop-source') {
          if (previous?.state !== 'failed' || !previous.error?.startsWith('SOURCE_RUNNING') || !previous.sourceRoot || !previous.sourceData) throw new Error('The selected source does not match the blocked import');
          const from = path.resolve(req.body.from).toLowerCase();
          if (![previous.sourceRoot, previous.sourceData].some(value => path.resolve(value).toLowerCase() === from)) throw new Error('The selected source does not match the blocked import');
          const sourceRoot = await realpath(previous.sourceRoot);
          const sourceData = await realpath(previous.sourceData);
          const current = layout(options);
          if (!current || !inside(sourceRoot, sourceData) || inside(sourceRoot, await realpath(current.appRoot)) || inside(sourceRoot, process.execPath)) throw new Error('현재 버전이 있는 폴더의 프로세스는 종료할 수 없습니다. 이전 버전을 직접 닫아 주세요.');
          await stopProcessesInsideRoot(sourceRoot, { list: listProcesses, ...(options.terminateProcess ? { terminate: options.terminateProcess } : {}) });
          await record(options.dataRoot, { state: 'pending', sourceRoot, sourceData, requestedAt: new Date().toISOString() });
          return { state: 'pending', restartRequired: true };
        }
        const found = await discoverDataImports(options);
        const from = path.resolve(req.body.from);
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        const exact = found.candidates.find(item => same(item.sourceData, from));
        const byRoot = exact ? [] : found.candidates.filter(item => same(item.sourceRoot, from));
        if (byRoot.length > 1) throw new Error(`이 폴더에는 가져올 수 있는 작업 위치가 ${byRoot.length}개 있어 하나를 고를 수 없습니다. --from 에 다음 중 하나의 data 경로를 지정해 주세요: ${byRoot.map(item => item.sourceData).join(' | ')}`);
        const candidate = exact ?? byRoot[0];
        if (!candidate) throw new Error('이전 작업 폴더를 찾지 못했습니다. 원본 폴더가 그대로 있는지 확인해 주세요.');
        const processes = processesInsideRoot(candidate.sourceRoot, await listProcesses());
        if (processes.length) {
          const error = 'SOURCE_RUNNING: 이전 버전이 실행 중입니다. 이전 버전을 닫은 뒤 다시 가져와 주세요.';
          await record(options.dataRoot, { state: 'failed', error, sourceRoot: candidate.sourceRoot, sourceData: candidate.sourceData });
          return { code: 'SOURCE_RUNNING', error, runningSource: { sourceRoot: candidate.sourceRoot, sourceData: candidate.sourceData, processes } } satisfies DataImportSourceRunningError;
        }
        await record(options.dataRoot, { state: 'pending', sourceRoot: candidate.sourceRoot, sourceData: candidate.sourceData, requestedAt: new Date().toISOString() });
        return { state: 'pending', restartRequired: true };
      });
      res.status('code' in result ? 409 : 200).json(result);
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
