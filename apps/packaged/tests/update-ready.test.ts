import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { writeUpdateReadyReceipt } from '../src/update-ready.js';

describe('update readiness receipt', () => {
  it('writes the launcher transaction receipt outside app only for the target version', async () => {
    const top = await mkdtemp(join(tmpdir(), 'ready-'));
    try {
      await mkdir(join(top, 'app'));
      await writeFile(join(top, 'Readable Studio.exe'), 'launcher stub');
      await writeFile(join(top, 'app', 'Readable Studio.exe'), 'Electron payload');
      const env = { READABLE_UPDATE_TRANSACTION: 'transaction-id', READABLE_UPDATE_TARGET: '1.3.0' };
      await expect(writeUpdateReadyReceipt('1.2.1', env, join(top, 'app', 'Readable Studio.exe'), 42)).rejects.toThrow();
      await writeUpdateReadyReceipt('1.3.0', env, join(top, 'app', 'Readable Studio.exe'), 42);
      expect(JSON.parse(await readFile(join(top, 'update-ready.json'), 'utf8'))).toEqual({ id: 'transaction-id', version: '1.3.0', pid: 42 });
      expect(await readdir(join(top, 'app'))).toEqual(['Readable Studio.exe']);
      expect(await readdir(top)).not.toContain('update-ready.42.tmp');
    } finally { await rm(top, { recursive: true, force: true }); }
  });
  it('writes no receipt for a legacy folder named app without a launcher stub', async () => {
    const top = await mkdtemp(join(tmpdir(), 'ready-legacy-'));
    try {
      await mkdir(join(top, 'app'));
      await writeFile(join(top, 'app', 'Readable Studio.exe'), 'legacy executable');
      await expect(writeUpdateReadyReceipt('1.3.0', {
        READABLE_UPDATE_TRANSACTION: 'transaction-id', READABLE_UPDATE_TARGET: '1.3.0',
      }, join(top, 'app', 'Readable Studio.exe'), 42)).resolves.toBeUndefined();
      expect(await readdir(top)).toEqual(['app']);
      expect(await readdir(join(top, 'app'))).toEqual(['Readable Studio.exe']);
    } finally { await rm(top, { recursive: true, force: true }); }
  });
  it('does nothing on an ordinary launch', async () => {
    await expect(writeUpdateReadyReceipt('1.2.1', {}, 'does-not-exist/app/Readable Studio.exe')).resolves.toBeUndefined();
  });
});
