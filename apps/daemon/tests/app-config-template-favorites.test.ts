import { execFile } from 'node:child_process';
import { Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEMPLATE_FAVORITES_MAX } from '@readable-studio/contracts';
import { readAppConfig, writeAppConfig } from '../src/app-config.js';
import { startServer } from '../src/server.js';

describe('templateFavorites app config', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'readable-favorites-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('defaults to an empty list for configs written before the key existed', async () => {
    await writeFile(path.join(dataDir, 'app-config.json'), JSON.stringify({ agentId: 'claude' }));
    const config = await readAppConfig(dataDir);
    expect(config.templateFavorites).toEqual([]);
    expect(config.agentId).toBe('claude');
  });

  it('persists the list in order and reads it back', async () => {
    await writeAppConfig(dataDir, { templateFavorites: ['b', 'a', 'c'] });
    expect(JSON.parse(await readFile(path.join(dataDir, 'app-config.json'), 'utf8')))
      .toHaveProperty('templateFavorites', ['b', 'a', 'c']);
    expect((await readAppConfig(dataDir)).templateFavorites).toEqual(['b', 'a', 'c']);
  });

  it('drops non-strings, blanks and duplicates while keeping first-seen order', async () => {
    const written = await writeAppConfig(dataDir, {
      templateFavorites: ['a', '', '  ', 7, null, 'b', 'a', ' b ', 'c'],
    });
    expect(written.templateFavorites).toEqual(['a', 'b', 'c']);
  });

  it('caps the list at the contract maximum', async () => {
    expect(TEMPLATE_FAVORITES_MAX).toBe(200);
    const ids = Array.from({ length: TEMPLATE_FAVORITES_MAX + 25 }, (_, i) => `tpl-${i}`);
    const written = await writeAppConfig(dataDir, { templateFavorites: ids });
    expect(written.templateFavorites).toEqual(ids.slice(0, TEMPLATE_FAVORITES_MAX));
  });

  it('keeps the saved list when the payload is not an array and resets on null', async () => {
    await writeAppConfig(dataDir, { templateFavorites: ['a'] });
    expect((await writeAppConfig(dataDir, { templateFavorites: 'a' })).templateFavorites).toEqual(['a']);
    expect((await writeAppConfig(dataDir, { agentId: 'codex' })).templateFavorites).toEqual(['a']);
    expect((await writeAppConfig(dataDir, { templateFavorites: null })).templateFavorites).toEqual([]);
  });
});

describe('readable templates favorites over HTTP', () => {
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  let baseUrl: string;
  let server: Server | undefined;
  let shutdown: (() => Promise<void> | void) | undefined;
  let configFile: string;

  beforeAll(async () => {
    const isolated = process.env.READABLE_DATA_DIR;
    if (!isolated) throw new Error('Test setup must isolate READABLE_DATA_DIR');
    configFile = path.join(isolated, 'app-config.json');
    const started = await startServer({ port: 0, returnServer: true });
    if (typeof started !== 'object' || started === null
      || !('url' in started) || typeof started.url !== 'string'
      || !('server' in started) || !(started.server instanceof Server)) {
      throw new Error('startServer must return the listening server');
    }
    baseUrl = started.url;
    server = started.server;
    if ('shutdown' in started && typeof started.shutdown === 'function') {
      const stop = started.shutdown;
      shutdown = async () => { await stop(); };
    }
  }, 60_000);
  afterAll(async () => {
    await shutdown?.();
    const running = server;
    if (running) await new Promise<void>((resolve, reject) => running.close((error) => error ? reject(error) : resolve()));
  });
  beforeEach(async () => {
    await writeFile(configFile, JSON.stringify({ agentId: 'claude' }));
  });

  async function favorites(...args: readonly string[]) {
    const { stdout } = await execute(process.execPath, [tsx, cli, 'templates', 'favorites', ...args, '--json'], {
      env: { ...process.env, READABLE_DAEMON_URL: baseUrl },
      timeout: 20_000,
    });
    return JSON.parse(stdout) as { templateFavorites: string[] };
  }

  it('round-trips add, list and remove through the same endpoint the UI uses', async () => {
    expect(await favorites('list')).toEqual({ templateFavorites: [] });
    expect(await favorites('add', 'plugin-one')).toEqual({ templateFavorites: ['plugin-one'] });
    expect(await favorites('add', 'plugin-two')).toEqual({ templateFavorites: ['plugin-one', 'plugin-two'] });
    expect(await favorites('add', 'plugin-one')).toEqual({ templateFavorites: ['plugin-one', 'plugin-two'] });
    const response = await fetch(`${baseUrl}/api/app-config`);
    expect(await response.json()).toMatchObject({
      config: { templateFavorites: ['plugin-one', 'plugin-two'], agentId: 'claude' },
    });
    expect(await favorites('remove', 'plugin-one')).toEqual({ templateFavorites: ['plugin-two'] });
    expect(await favorites('remove', 'missing')).toEqual({ templateFavorites: ['plugin-two'] });
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toHaveProperty('templateFavorites', ['plugin-two']);
  });

  it('exits 2 with usage when add has no id', async () => {
    await expect(favorites('add')).rejects.toMatchObject({ code: 2 });
  });
});
