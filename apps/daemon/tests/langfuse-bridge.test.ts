import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  reportRunCompletedFromDaemon,
  reportRunFeedbackFromDaemon,
} from '../src/langfuse-bridge.js';

function makeDb() {
  return {
    prepare() {
      throw new Error('telemetry bridge should not read messages when egress is disabled');
    },
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'run-id-1',
    projectId: 'proj-1',
    conversationId: 'conv-1',
    assistantMessageId: 'msg-1',
    agentId: 'claude',
    status: 'succeeded',
    createdAt: now - 4500,
    updatedAt: now,
    events: [
      {
        id: 1,
        event: 'agent',
        timestamp: now - 4000,
        data: {
          type: 'usage',
          usage: { input_tokens: 100, output_tokens: 200 },
        },
      },
    ],
    userPrompt: 'design a coffee landing page',
    ...overrides,
  };
}

describe('langfuse-bridge telemetry egress policy', () => {
  const savedEnv = {
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
    READABLE_TELEMETRY_RELAY_URL: process.env.READABLE_TELEMETRY_RELAY_URL,
  };

  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'readable-bridge-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    restoreEnv(savedEnv);
    vi.restoreAllMocks();
  });

  async function writeAppCfg(cfg: Record<string, unknown>) {
    await writeFile(path.join(dataDir, 'app-config.json'), JSON.stringify(cfg));
  }

  function configureTelemetrySinkEnv() {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    process.env.LANGFUSE_BASE_URL = 'https://cloud.langfuse.com';
    process.env.READABLE_TELEMETRY_RELAY_URL =
      'https://telemetry.readable-studio.ai/api/langfuse';
  }

  it('does not submit run traces even when a stale config has full telemetry consent', async () => {
    await writeAppCfg({
      installationId: 'install-uuid-1',
      telemetry: { metrics: true, content: true, artifactManifest: true },
    });
    configureTelemetrySinkEnv();
    const fetchSpy = vi.fn();

    await expect(
      reportRunCompletedFromDaemon({
        db: makeDb(),
        dataDir,
        run: makeRun() as any,
        fetchImpl: fetchSpy as any,
      }),
    ).resolves.toEqual({
      langfuse_expected: false,
      langfuse_delivery_status: 'not_expected',
      langfuse_drop_reason: 'missing_sink_config',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses fresh-install defaults that keep run telemetry off', async () => {
    const fetchSpy = vi.fn();

    await expect(
      reportRunCompletedFromDaemon({
        db: makeDb(),
        dataDir,
        run: makeRun() as any,
        fetchImpl: fetchSpy as any,
      }),
    ).resolves.toEqual({
      langfuse_expected: false,
      langfuse_delivery_status: 'not_expected',
      langfuse_drop_reason: 'metrics_consent_off',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not submit feedback scores even when telemetry consent and sink env are present', async () => {
    await writeAppCfg({
      installationId: 'install-uuid-1',
      telemetry: { metrics: true, content: true },
    });
    configureTelemetrySinkEnv();
    const fetchSpy = vi.fn();

    await expect(
      reportRunFeedbackFromDaemon({
        dataDir,
        runId: 'run-id-1',
        rating: 'positive',
        reasonCodes: ['helpful'],
        hasCustomReason: true,
        customReason: 'worked well',
        scoreMetadata: { projectId: 'proj-1' },
        fetchImpl: fetchSpy as any,
      }),
    ).resolves.toEqual({ status: 'skipped_no_sink' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps feedback consent semantics when telemetry is off', async () => {
    await writeAppCfg({
      installationId: 'install-uuid-1',
      telemetry: { metrics: false, content: true },
    });
    configureTelemetrySinkEnv();

    await expect(
      reportRunFeedbackFromDaemon({
        dataDir,
        runId: 'run-id-1',
        rating: 'negative',
        reasonCodes: [],
        hasCustomReason: false,
        customReason: '',
      }),
    ).resolves.toEqual({ status: 'skipped_consent' });
  });
});

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
