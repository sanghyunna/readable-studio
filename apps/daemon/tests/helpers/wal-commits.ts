import { readFileSync } from 'node:fs';

// Committed write transactions in the current WAL generation. Each commit ends
// with exactly one frame whose "database size after commit" field is non-zero.
export function readWalCommits(dbFile: string): { commits: number; wrapped: boolean } {
  let wal: Buffer;
  try {
    wal = readFileSync(`${dbFile}-wal`);
  } catch {
    return { commits: 0, wrapped: false };
  }
  if (wal.length < 32) return { commits: 0, wrapped: false };
  const frameSize = 24 + wal.readUInt32BE(8);
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  let commits = 0;
  let offset = 32;
  for (; offset + frameSize <= wal.length; offset += frameSize) {
    if (wal.readUInt32BE(offset + 8) !== salt1 || wal.readUInt32BE(offset + 12) !== salt2) break;
    if (wal.readUInt32BE(offset + 4) !== 0) commits += 1;
  }
  // Stale frames after the valid prefix mean the WAL restarted mid-measurement.
  return { commits, wrapped: offset !== wal.length };
}
