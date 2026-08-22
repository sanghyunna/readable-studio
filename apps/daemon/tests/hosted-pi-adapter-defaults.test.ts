import assert from 'node:assert/strict';
import path from 'node:path';

import { SIDECAR_CONTRACT } from '@readable-studio/sidecar-proto';
import { describe, test, vi } from 'vitest';

const brokerCall = vi.hoisted<{ socketBase: string | null }>(() => ({ socketBase: null }));

vi.mock('../src/runtimes/hosted-pi-broker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtimes/hosted-pi-broker.js')>();
  return {
    ...actual,
    createHostedPiBroker: async (options: Parameters<typeof actual.createHostedPiBroker>[0]) => {
      brokerCall.socketBase = options.socketBase ?? null;
      throw new TypeError('broker call captured');
    },
  };
});

import { createHostedPiRuntimeAdapter } from '../src/runtimes/hosted-pi-adapter.js';

describe('hosted Pi adapter defaults', () => {
  test('passes the canonical sidecar IPC base to the broker', async () => {
    const adapter = createHostedPiRuntimeAdapter({ runtimeRoot: path.join(process.cwd(), 'runtime') });

    await assert.rejects(() => adapter({
      userKey: 'user-a',
      runId: 'run-a',
      projectId: 'project-a',
      generation: 1,
      projectRoot: path.join(process.cwd(), 'project'),
      cwd: path.join(process.cwd(), 'project'),
    }));

    assert.equal(brokerCall.socketBase, path.resolve(SIDECAR_CONTRACT.defaults.ipcBase));
  });
});
