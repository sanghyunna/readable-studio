// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, test } from 'vitest';

import {
  HOSTED_ASSISTANT_MESSAGE_ID,
  expectHttpStatus,
  jsonMutation,
  readSseUntil,
  readText,
  startRun,
  waitForRun,
} from '@/hosted-http';
import { createSmokeSuite } from '@/smoke-suite';

type ProjectResponse = { project: { id: string } };
type ConversationResponse = { conversation: { id: string } };

describe('hosted eviction and snapshot recovery', () => {
  test('restores idle users and falls back from invalid snapshots', async () => {
    const suite = await createSmokeSuite('hosted-recovery');

    await suite.with.hosted(async (context) => {
      const a = context.identity('a');
      const b = context.identity('b');
      const projectA = await jsonMutation<ProjectResponse>(a, 'POST', '/api/projects', {
        title: 'Active A', kind: 'prototype',
      });
      const conversationA = await jsonMutation<ConversationResponse>(
        a,
        'POST',
        `/api/projects/${projectA.project.id}/conversations`,
        { title: 'Active A conversation', sessionMode: 'design' },
      );
      await jsonMutation(
        a,
        'PUT',
        `/api/projects/${projectA.project.id}/conversations/${conversationA.conversation.id}/messages/${HOSTED_ASSISTANT_MESSAGE_ID}`,
        { role: 'assistant', content: '' },
      );
      const projectB = await jsonMutation<ProjectResponse>(b, 'POST', '/api/projects', {
        title: 'Idle B', kind: 'prototype',
      });
      await jsonMutation(b, 'POST', `/api/projects/${projectB.project.id}/files`, {
        name: 'state.txt', content: 'baseline',
      });

      await jsonMutation(a, 'PUT', '/api/hosted/provider', {
        provider: 'anthropic', key: context.provider.credential('a'),
      });
      const activeA = await startRun(
        a,
        projectA.project.id,
        conversationA.conversation.id,
        'active-a',
        '[tenant-a-marker] [hold-for-cancel] keep A active during B eviction',
      );
      await readSseUntil(a, `/api/runs/${activeA.runId}/events`, /event: start/u);
      await jsonMutation(b, 'PUT', '/api/hosted/provider', {
        provider: 'anthropic', key: context.provider.credential('b'),
      });
      await delay(750);

      expect(await b.json('/api/hosted/provider'))
        .toEqual({ configured: false, provider: null });
      expect(await readText(b, `/api/projects/${projectB.project.id}/files/state.txt`))
        .toBe('baseline');
      expect(await a.json('/api/hosted/provider'))
        .toEqual({ configured: true, provider: 'anthropic' });
      await expectHttpStatus(a, `/api/runs/${activeA.runId}/cancel`, 200, { method: 'POST' });
      await waitForRun(a, activeA.runId, 'canceled');

      await jsonMutation(b, 'POST', `/api/projects/${projectB.project.id}/files`, {
        name: 'state.txt', content: 'corrupt-fallback',
      });
      await context.restart('graceful', async () => {
        await corruptNewestSnapshot(context.runtimeRoot, 'hosted-acceptance-user-b');
      });
      expect(await readText(b, `/api/projects/${projectB.project.id}/files/state.txt`))
        .toBe('baseline');

      await jsonMutation(b, 'POST', `/api/projects/${projectB.project.id}/files`, {
        name: 'state.txt', content: 'incomplete-fallback',
      });
      await context.restart('graceful', async () => {
        await addIncompleteSnapshot(context.runtimeRoot, 'hosted-acceptance-user-b');
      });
      expect(await readText(b, `/api/projects/${projectB.project.id}/files/state.txt`))
        .toBe('incomplete-fallback');

      await jsonMutation(b, 'POST', `/api/projects/${projectB.project.id}/files`, {
        name: 'state.txt', content: 'mismatched-fallback',
      });
      await context.restart('graceful', async () => {
        await mismatchNewestSnapshot(context.runtimeRoot, 'hosted-acceptance-user-b');
      });
      expect(await readText(b, `/api/projects/${projectB.project.id}/files/state.txt`))
        .toBe('incomplete-fallback');

      await suite.report.json('recovery-summary.json', {
        idleEviction: 'restored',
        snapshotFallbacks: ['corrupt', 'incomplete', 'mismatched'],
      });
    }, { idleEvictionMs: 250 });
  }, 600_000);
});

async function snapshotRoot(runtimeRoot: string, userKey: string): Promise<string> {
  const snapshotsRoot = join(runtimeRoot, 'snapshots');
  for (const storageKey of await readdir(snapshotsRoot)) {
    const candidate = join(snapshotsRoot, storageKey);
    try {
      const marker = JSON.parse(await readFile(join(candidate, '.identity.json'), 'utf8')) as {
        userKey?: unknown;
      };
      if (marker.userKey === userKey) return candidate;
    } catch {
      // This entry is not the requested user's snapshot root.
    }
  }
  throw new Error(`hosted snapshot root was not found for ${userKey}`);
}

async function newestVersion(runtimeRoot: string, userKey: string): Promise<string> {
  const root = await snapshotRoot(runtimeRoot, userKey);
  const versions = (await readdir(join(root, 'versions')))
    .filter((entry) => /^\d{20}$/u.test(entry))
    .sort();
  const sequence = versions.at(-1);
  if (sequence == null) throw new Error(`hosted snapshot version was not found for ${userKey}`);
  return join(root, 'versions', sequence);
}

async function corruptNewestSnapshot(runtimeRoot: string, userKey: string): Promise<void> {
  const version = await newestVersion(runtimeRoot, userKey);
  await writeFile(join(version, 'payload', 'projects', 'unhashed.txt'), 'corrupt', 'utf8');
}

async function addIncompleteSnapshot(runtimeRoot: string, userKey: string): Promise<void> {
  const root = await snapshotRoot(runtimeRoot, userKey);
  const sequence = '99999999999999999999';
  await mkdir(join(root, 'versions', sequence));
  await writeFile(join(root, 'latest'), `${sequence}\n`, 'utf8');
}

async function mismatchNewestSnapshot(runtimeRoot: string, userKey: string): Promise<void> {
  const version = await newestVersion(runtimeRoot, userKey);
  const manifestPath = join(version, 'manifest.json');
  const completionPath = join(version, '.complete.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.userKey = 'mismatched-user';
  const manifestText = `${JSON.stringify(manifest)}\n`;
  await writeFile(manifestPath, manifestText, 'utf8');
  const completion = JSON.parse(await readFile(completionPath, 'utf8')) as Record<string, unknown>;
  completion.manifestSha256 = createHash('sha256').update(manifestText).digest('hex');
  await writeFile(completionPath, `${JSON.stringify(completion)}\n`, 'utf8');
}
