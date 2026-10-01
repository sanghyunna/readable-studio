import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import type { DataImportCandidate, DataImportCandidatesResponse, DataImportState } from '@readable-studio/contracts';

const MARKER = 'data-import.json';
const OFFER_OWNER = `${process.pid}:${Date.now()}`;
interface Decision { state: DataImportState; offeredBy?: string; sourceRoot?: string; sourceData?: string; error?: string; requestedAt?: string }
export interface DataImportRouteOptions {
  dataRoot: string;
  /** Packaged host supplies READABLE_UPDATE_ROOT; fixed data layout is the fallback. */
  appRoot?: string;
  namespace?: string;
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
export async function discoverDataImports(options: DataImportRouteOptions): Promise<{ candidates: DataImportCandidate[]; warnings: string[] }> {
  const resolved = layout(options);
  if (!resolved) return { candidates: [], warnings: [] };
  const { appRoot, namespace } = resolved;
  const siblings = (await readdir(path.dirname(appRoot), { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink());
  if (siblings.length > 512) throw new Error('Too many sibling folders for bounded import discovery');
  const probes = siblings.map(entry => {
    const sourceRoot = path.join(path.dirname(appRoot), entry.name);
    return { sourceRoot, sourceData: path.join(sourceRoot, 'ReadableStudioData', 'namespaces', namespace, 'data') };
  });
  probes.push({ sourceRoot: appRoot, sourceData: path.join(appRoot, 'ReadableStudioData', 'data') },
    { sourceRoot: appRoot, sourceData: path.join(appRoot, '.readable-studio') });
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

export function registerDataImportRoutes(app: Express, options: DataImportRouteOptions): void {
  // Serialize decision writes so concurrent renderer/CLI requests cannot select
  // different sources or replace an accepted request with a decline.
  let serial: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = serial.then(fn, fn); serial = result.catch(() => undefined); return result;
  };
  app.get('/api/data-import/candidates', async (_req, res) => {
    try {
      const result = await locked(async (): Promise<DataImportCandidatesResponse> => {
        const previous = await decision(options.dataRoot);
        if (previous && (previous.state !== 'offered' || previous.offeredBy !== OFFER_OWNER)) return { state: previous.state === 'offered' ? 'unavailable' : previous.state, candidates: [], ...(previous.error ? { error: previous.error } : {}) };
        if (!layout(options) || !(await empty(options.dataRoot))) return { state: 'unavailable', candidates: [] };
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
      if (action !== 'decline' && (action !== 'import' || typeof req.body?.from !== 'string')) { res.status(400).json({ error: 'Invalid import request' }); return; }
      const result = await locked(async () => {
        const previous = await decision(options.dataRoot);
        if (previous?.state === 'done' || previous?.state === 'pending') throw new Error('이미 가져오기를 요청했습니다. 앱을 다시 시작해 주세요.');
        if (!(await empty(options.dataRoot))) throw new Error('현재 폴더에 작업이 있어 덮어쓰지 않았습니다.');
        if (action === 'decline') {
          await record(options.dataRoot, { state: 'declined' }); return { state: 'declined', restartRequired: false };
        }
        const found = await discoverDataImports(options);
        const from = path.resolve(req.body.from);
        const candidate = found.candidates.find(item => item.sourceData.toLowerCase() === from.toLowerCase() || item.sourceRoot.toLowerCase() === from.toLowerCase());
        if (!candidate) throw new Error('이전 작업 폴더를 찾지 못했습니다. 원본 폴더가 그대로 있는지 확인해 주세요.');
        await record(options.dataRoot, { state: 'pending', sourceRoot: candidate.sourceRoot, sourceData: candidate.sourceData, requestedAt: new Date().toISOString() });
        return { state: 'pending', restartRequired: true };
      });
      res.json(result);
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
