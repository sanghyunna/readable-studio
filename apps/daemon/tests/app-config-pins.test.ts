import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAppConfig, writeAppConfig } from '../src/app-config.js';

describe('daemon-owned session pins', () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'readable-pins-')); });
  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  it('defaults old configurations to no pins', async () => {
    expect(await readAppConfig(dataDir)).toHaveProperty('pinnedSessionIds', []);
  });

  it('normalizes ordered pins read from disk and caps them at 200', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `session-${i}`);
    await writeFile(path.join(dataDir, 'app-config.json'), JSON.stringify({
      pinnedSessionIds: ['', '  ', null, 7, ' session-0 ', 'session-0', ...ids],
    }));
    expect(await readAppConfig(dataDir)).toHaveProperty('pinnedSessionIds', ids.slice(0, 200));
  });

  it('preserves pins across preference writes but rejects general pin writes', async () => {
    const file = path.join(dataDir, 'app-config.json');
    await writeFile(file, JSON.stringify({ pinnedSessionIds: ['second', 'first'] }));
    await writeAppConfig(dataDir, { agentId: 'codex', pinnedSessionIds: ['replacement'] });
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty('pinnedSessionIds', ['second', 'first']);
    expect(await readAppConfig(dataDir)).toHaveProperty('agentId', 'codex');
  });
});
