import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { storedAgentScanSchema, type StoredAgentScan } from '@readable-studio/contracts';
import type { AgentLaunchResolution } from './launch.js';

export async function executableSnapshotIdentity(launch: AgentLaunchResolution): Promise<string | null> {
  if (!launch.selectedPath || !launch.launchPath) return null;
  try {
    const identities = await Promise.all([...new Set([launch.selectedPath, launch.launchPath])].map(async (file) => {
      const resolved = await realpath(file);
      const info = await stat(resolved, { bigint: true });
      if (!info.isFile()) return null;
      // File ID catches replacement even with preserved size/mtime; ctime catches
      // in-place rewrites. Follow links and include the actual native launch target.
      return [file, resolved, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].map(String);
    }));
    return identities.includes(null) ? null : JSON.stringify(identities);
  } catch (error) {
    if (error instanceof Error && 'code' in error &&
        ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(error.code))) return null;
    throw error;
  }
}

// The completion marker and results are one atomic record, never separate commits.
export async function readStoredAgentScan(dataDir: string): Promise<StoredAgentScan | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(dataDir, 'agent-scan.json'), 'utf8'));
    const parsed = storedAgentScanSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return null;
    throw error;
  }
}

export async function clearStoredAgentScan(dataDir: string): Promise<void> {
  await rm(path.join(dataDir, 'agent-scan.json'), { force: true });
}

export async function writeStoredAgentScan(dataDir: string, scan: StoredAgentScan, signal: AbortSignal): Promise<void> {
  const file = path.join(dataDir, 'agent-scan.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dataDir, { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(scan), { encoding: 'utf8', flush: true });
    signal.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
