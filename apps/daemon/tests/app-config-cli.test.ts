import { execFile } from 'node:child_process';
import { Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
let baseUrl: string;
let server: Server | undefined;
let shutdown: (() => Promise<void> | void) | undefined;
let configFile: string;

beforeAll(async () => {
  const dataDir = process.env.READABLE_DATA_DIR;
  if (!dataDir) throw new Error('Test setup must isolate READABLE_DATA_DIR');
  configFile = path.join(dataDir, 'app-config.json');
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

async function runConfig(args: readonly string[]) {
  const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  return execute(process.execPath, [tsx, cli, 'config', ...args, '--json'], {
    env: { ...process.env, READABLE_DAEMON_URL: baseUrl },
    timeout: 15_000,
  });
}

describe('performance profile HTTP and CLI', () => {
  it('prints full JSON when the generic CLI reads an absent profile', async () => {
    // Given config without a profile.
    // When the real CLI reads the profile over HTTP.
    const result = await runConfig(['get', 'performanceProfile']);
    // Then JSON exposes the effective default.
    expect(JSON.parse(result.stdout)).toBe('full');
  });

  it.each(['full', 'low'])('persists %s when the generic CLI sets the profile', async (profile) => {
    // Given the real daemon with existing preferences.
    // When the CLI sets the profile.
    const result = await runConfig(['set', 'performanceProfile', profile]);
    // Then output, persisted config, and the HTTP read expose the choice.
    expect(JSON.parse(result.stdout)).toMatchObject({ performanceProfile: profile, agentId: 'claude' });
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toHaveProperty('performanceProfile', profile);
    const response = await fetch(`${baseUrl}/api/app-config`);
    expect(await response.json()).toMatchObject({ config: { performanceProfile: profile } });
  });

  it('restores full when the generic CLI unsets low', async () => {
    // Given a non-default saved choice.
    await writeFile(configFile, JSON.stringify({ performanceProfile: 'low', agentId: 'claude' }));
    // When the CLI unsets that key.
    const result = await runConfig(['unset', 'performanceProfile']);
    // Then the default is persisted without losing another preference.
    expect(JSON.parse(result.stdout)).toMatchObject({ performanceProfile: 'full', agentId: 'claude' });
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toHaveProperty('performanceProfile', 'full');
  });

  it('returns a typed validation error without mutation when HTTP sends an unsupported profile', async () => {
    // Given a legacy file eligible for a read migration.
    const original = JSON.stringify({ performanceProfile: 'low', enabledAgentIds: [] });
    await writeFile(configFile, original);
    // When HTTP submits an unsupported value.
    const response = await fetch(`${baseUrl}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ performanceProfile: 'auto', agentId: 'codex' }),
    });
    // Then the repository error envelope identifies the rejected field, and disk is untouched.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: {
      code: 'VALIDATION_FAILED',
      details: { kind: 'validation', issues: [{ path: 'performanceProfile' }] },
    } });
    expect(await readFile(configFile, 'utf8')).toBe(original);
  });

  it('fails without mutation when the generic CLI sets an unsupported profile', async () => {
    // Given a saved low choice.
    const original = JSON.stringify({ performanceProfile: 'low', enabledAgentIds: [], agentId: 'claude' });
    await writeFile(configFile, original);
    // When the CLI submits an invalid choice.
    const result = runConfig(['set', 'performanceProfile', 'turbo']);
    // Then validation uses the normal exit code and preserves the typed envelope.
    await expect(result).rejects.toMatchObject({
      code: 2,
      stdout: '',
      stderr: expect.stringContaining('"code":"VALIDATION_FAILED"'),
    });
    await result.catch((error: unknown) => {
      if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') throw error;
      expect(JSON.parse(error.stderr)).toMatchObject({ error: {
        code: 'VALIDATION_FAILED',
        details: { kind: 'validation', issues: [{ path: 'performanceProfile' }] },
      } });
    });
    expect(await readFile(configFile, 'utf8')).toBe(original);
  });
});
