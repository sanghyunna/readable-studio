import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { spawnIsolatedAgent } from '../src/index.js';

it('becomes ready and streams when the isolated run has a broker', async () => {
  // Given: the broker-enabled launch used by packaged agent runs.
  const cwd = await mkdtemp(join(tmpdir(), 'isolated-ready-'));
  try {
    const command = join(cwd, 'agent.cmd');
    await writeFile(command, '@echo off\r\necho ready-stream\r\n');
    // When: the real helper launches a contained shim with its broker proxy.
    const child = await spawnIsolatedAgent({
      command, cwd, env: process.env, readExecutePaths: [], writablePaths: [cwd],
      broker: {
        pipeName: `\\\\.\\pipe\\LOCAL\\ReadableStudio.${randomUUID()}`,
        handleRequest: async () => JSON.stringify({ code: 0, stdout: '', stderr: '' }),
      },
    });
    const completed = new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    child.stdin.end();
    // Then: readiness completed and the isolated child actually streamed.
    expect(await completed).toEqual({ code: 0, stdout: 'ready-stream\r\n', stderr: '' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 25_000);
