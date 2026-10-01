import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { writeUpdateReadyReceipt } from '../src/update-ready.js';

describe('update readiness receipt', () => {
  it('writes the launcher transaction receipt outside app only for the target version', async () => {
    const top = await mkdtemp(join(tmpdir(), 'ready-'));
    try {
      const env = { READABLE_UPDATE_TRANSACTION: 'transaction-id', READABLE_UPDATE_TARGET: '1.3.0' };
      await expect(writeUpdateReadyReceipt('1.2.1', env, join(top, 'app', 'Readable Studio.exe'), 42)).rejects.toThrow();
      await writeUpdateReadyReceipt('1.3.0', env, join(top, 'app', 'Readable Studio.exe'), 42);
      expect(JSON.parse(await readFile(join(top, 'update-ready.json'), 'utf8'))).toEqual({ id: 'transaction-id', version: '1.3.0', pid: 42 });
    } finally { await rm(top, { recursive: true, force: true }); }
  });
  it('does nothing on an ordinary launch', async () => {
    await expect(writeUpdateReadyReceipt('1.2.1', {}, 'does-not-exist/app/Readable Studio.exe')).resolves.toBeUndefined();
  });
});
