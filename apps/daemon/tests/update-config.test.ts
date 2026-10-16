import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readAppConfig, writeAppConfig } from '../src/app-config.js';
import { updateDownload } from '../src/update-download.js';

it('defaults off and persists normalized HTTPS update preferences', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'update-config-'));
  try {
    expect((await readAppConfig(dir)).autoUpdate).toEqual({ enabled: false, serverUrl: null });
    expect((await writeAppConfig(dir, { autoUpdate: { enabled: true, serverUrl: ' https://updates.databricksapps.com/ ' } })).autoUpdate).toEqual({ enabled: true, serverUrl: 'https://updates.databricksapps.com' });
    for (const serverUrl of [null, 'http://updates.databricksapps.com', 'https://user:secret@updates.databricksapps.com', 'https://updates.databricksapps.com/?token=secret']) {
      await expect(writeAppConfig(dir, { autoUpdate: { enabled: true, serverUrl } })).rejects.toMatchObject({ key: 'autoUpdate' });
    }
    expect((await readAppConfig(dir)).autoUpdate?.serverUrl).toBe('https://updates.databricksapps.com');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('invalidates pending and ready offers when the update source changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'update-config-source-'));
  const download = updateDownload(dir);
  try {
    await writeAppConfig(dir, { autoUpdate: { enabled: true, serverUrl: 'https://a.databricksapps.com' } });
    download.status = { state: 'ready', received: 10, total: 10, version: '1.3.4', error: null, releaseUrl: 'https://a.databricksapps.com' };
    await writeAppConfig(dir, { autoUpdate: { enabled: true, serverUrl: 'https://b.databricksapps.com' } });
    expect(download.status).toMatchObject({ state: 'idle', version: null });
  } finally { await download.cancel(); await rm(dir, { recursive: true, force: true }); }
});
