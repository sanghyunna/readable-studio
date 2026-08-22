import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHostedRunReceiptStore,
  digestHostedRunIntent,
  type HostedRunReceiptResult,
} from '../src/hosted-run-receipts.js';
import type { NormalizedHostedRunIntentV1 } from '../src/hosted-run-adapter.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, {
    force: true,
    recursive: true,
  })));
});

function intent(overrides: Partial<NormalizedHostedRunIntentV1> = {}): NormalizedHostedRunIntentV1 {
  return {
    projectId: 'project-1',
    conversationId: 'conversation-1',
    assistantMessageId: 'message-1',
    agentId: 'agent-1',
    message: 'Hello',
    clientRequestId: 'retry-1',
    currentPrompt: 'Hello',
    sessionMode: 'design',
    skillIds: ['skill-b', 'skill-a'],
    designSystemId: null,
    attachmentIds: ['attachment-1'],
    commentAttachmentIds: [],
    model: null,
    reasoning: null,
    locale: 'en',
    contextSelectionIds: [],
    ...overrides,
  };
}

function result(suffix = '1'): HostedRunReceiptResult {
  return {
    runId: `run-${suffix}`,
    conversationId: `conversation-${suffix}`,
    assistantMessageId: `message-${suffix}`,
  };
}

describe('hosted run receipts', () => {
  it('returns the original stable result for a same-key, same-intent retry', () => {
    const database = new Database(':memory:');
    const store = createHostedRunReceiptStore(database);
    const first = store.accept({ routeKind: 'runs', intent: intent(), result: result() });
    const retry = store.accept({
      routeKind: 'runs',
      intent: intent(),
      result: result('different'),
    });

    expect(first).toMatchObject({ existing: false, receipt: { status: 'queued', result: result() } });
    expect(retry).toEqual({ existing: true, receipt: first.receipt });
    expect(store.count()).toBe(1);
    database.close();
  });

  it('rejects reuse of a retry key for a changed canonical intent', () => {
    const database = new Database(':memory:');
    const store = createHostedRunReceiptStore(database);
    store.accept({ routeKind: 'runs', intent: intent(), result: result() });

    expect(() => store.accept({
      routeKind: 'runs',
      intent: intent({ message: 'Changed', currentPrompt: 'Changed' }),
      result: result('2'),
    })).toThrowError(expect.objectContaining({ code: 'RETRY_KEY_REUSED', statusCode: 409 }));
    expect(store.get('retry-1')?.result).toEqual(result());
    database.close();
  });

  it('rejects a stable result that belongs to another conversation or message', () => {
    const database = new Database(':memory:');
    const store = createHostedRunReceiptStore(database);
    expect(() => store.accept({
      routeKind: 'runs',
      intent: intent(),
      result: { ...result(), conversationId: 'conversation-other' },
    })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(() => store.accept({
      routeKind: 'runs',
      intent: intent(),
      result: { ...result(), assistantMessageId: 'message-other' },
    })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
    expect(store.count()).toBe(0);
    database.close();
  });

  it('uses the exact deterministic hosted-run-intent-v1 canonical object', () => {
    const canonical = '{"agentId":"agent-1","assistantMessageId":"message-1","attachmentIds":["attachment-1"],"commentAttachmentIds":[],"contextSelectionIds":[],"conversationId":"conversation-1","currentPrompt":"Hello","designSystemId":null,"locale":"en","message":"Hello","model":null,"projectId":"project-1","reasoning":null,"routeKind":"runs","sessionMode":"design","skillIds":["skill-b","skill-a"],"version":"hosted-run-intent-v1"}';
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const reordered = {
      ...intent(),
      // These dispatcher/display values are deliberately outside the digest contract.
      requestId: 'server-request-a',
      displayName: 'Alice',
      analyticsHint: 'source-a',
    } as NormalizedHostedRunIntentV1;
    const reverseOrdered = Object.fromEntries(
      Object.entries(intent()).reverse(),
    ) as unknown as NormalizedHostedRunIntentV1;

    expect(digestHostedRunIntent('runs', reordered)).toBe(expected);
    expect(digestHostedRunIntent('runs', reverseOrdered)).toBe(expected);
    expect(digestHostedRunIntent('runs', intent({
      clientRequestId: 'another-retry-key',
    }))).toBe(expected);
    expect(digestHostedRunIntent('chat', intent())).not.toBe(expected);
  });

  it('persists status updates and reconciles active receipts after reopening', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'readable-hosted-receipts-'));
    cleanupPaths.push(root);
    const databaseFile = path.join(root, 'app.sqlite');
    let database = new Database(databaseFile);
    let store = createHostedRunReceiptStore(database, { now: () => 20 });
    store.accept({ routeKind: 'chat', intent: intent(), result: result() });
    expect(store.updateStatus('retry-1', 'running')).toMatchObject({ status: 'running' });
    database.close();

    database = new Database(databaseFile);
    store = createHostedRunReceiptStore(database, { now: () => 30 });
    expect(store.get('retry-1')).toMatchObject({
      routeKind: 'chat',
      status: 'running',
      resumable: false,
      result: result(),
    });
    store.accept({
      routeKind: 'runs',
      intent: intent({
        clientRequestId: 'retry-0',
        conversationId: 'conversation-2',
        assistantMessageId: 'message-2',
      }),
      result: result('2'),
    });
    store.updateStatus('retry-0', 'succeeded');
    expect(store.list().map((receipt) => receipt.clientRequestId)).toEqual([
      'retry-1',
      'retry-0',
    ]);
    expect(store.reconcileInterrupted()).toBe(1);
    expect(store.get('retry-1')).toMatchObject({ status: 'interrupted', resumable: true });
    database.close();
  });

  it('keeps receipt status monotonic and terminal results immutable', () => {
    const database = new Database(':memory:');
    const store = createHostedRunReceiptStore(database);
    store.accept({ routeKind: 'runs', intent: intent(), result: result() });
    store.updateStatus('retry-1', 'running');
    expect(() => store.updateStatus('retry-1', 'queued')).toThrowError(
      expect.objectContaining({ code: 'CONFLICT', statusCode: 409 }),
    );
    store.updateStatus('retry-1', 'succeeded');
    expect(() => store.updateStatus('retry-1', 'canceled')).toThrowError(
      expect.objectContaining({ code: 'CONFLICT', statusCode: 409 }),
    );
    expect(() => store.updateStatus('retry-1', 'succeeded', { resumable: true })).toThrowError(
      expect.objectContaining({ code: 'BAD_REQUEST', statusCode: 400 }),
    );
    expect(store.updateStatus('retry-1', 'succeeded')).toMatchObject({ status: 'succeeded' });
    expect(store.get('retry-1')).toMatchObject({ status: 'succeeded', result: result() });
    database.close();
  });

  it('persists only opaque result identifiers and the digest, never intent authority or paths', () => {
    const database = new Database(':memory:');
    const store = createHostedRunReceiptStore(database);
    store.accept({
      routeKind: 'runs',
      intent: intent({
        message: 'credential=super-secret C:\\private\\workspace',
        currentPrompt: 'credential=super-secret C:\\private\\workspace',
      }),
      result: result(),
    });

    const columns = database.prepare('PRAGMA table_info(hosted_run_receipts)').all()
      .map((row) => (row as { name: string }).name);
    const row = database.prepare('SELECT * FROM hosted_run_receipts').get();
    const persisted = JSON.stringify(row);
    expect(columns).not.toContain('user_key');
    expect(columns).not.toContain('intent_json');
    expect(columns.some((name) => name.endsWith('_path'))).toBe(false);
    expect(persisted).not.toContain('super-secret');
    expect(persisted).not.toContain('private');
    database.close();
  });

  it('bounds admission without evicting accepted retry identities', () => {
    const database = new Database(':memory:');
    let timestamp = 10;
    const store = createHostedRunReceiptStore(database, {
      maxReceipts: 2,
      now: () => timestamp++,
    });
    store.accept({ routeKind: 'runs', intent: intent(), result: result() });
    store.updateStatus('retry-1', 'succeeded');
    store.accept({
      routeKind: 'runs',
      intent: intent({
        clientRequestId: 'retry-2',
        conversationId: 'conversation-2',
        assistantMessageId: 'message-2',
      }),
      result: result('2'),
    });
    expect(() => store.accept({
      routeKind: 'runs',
      intent: intent({
        clientRequestId: 'retry-3',
        conversationId: 'conversation-3',
        assistantMessageId: 'message-3',
      }),
      result: result('3'),
    })).toThrowError(expect.objectContaining({ code: 'HOSTED_CAPACITY_EXHAUSTED' }));
    expect(store.count()).toBe(2);
    expect(store.get('retry-1')).toMatchObject({ status: 'succeeded', result: result() });
    expect(store.accept({ routeKind: 'runs', intent: intent(), result: result('different') }))
      .toMatchObject({ existing: true, receipt: { result: result() } });
    database.close();
  });
});
