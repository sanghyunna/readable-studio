// @vitest-environment node

import { describe, expect, test } from 'vitest';

import {
  HOSTED_ASSISTANT_MESSAGE_ID,
  jsonMutation,
  readText,
  startRun,
  waitForRun,
} from '@/hosted-http';
import { createSmokeSuite } from '@/smoke-suite';

type ProjectResponse = { project: { id: string; name: string } };
type ConversationResponse = { conversation: { id: string } };
type PreviewResponse = { url: string; opaqueOrigin: boolean; iframeSandbox: string };

describe('hosted main spec', () => {
  test('runs the authenticated local hosted workflow', async () => {
    const suite = await createSmokeSuite('hosted-main');

    await suite.with.hosted(async (context) => {
      const user = context.identity('a');
      const session = await user.json<{
        csrfToken: string;
        providers: Array<{ id: string }>;
      }>('/api/hosted/session');
      expect(session.csrfToken).toEqual(expect.any(String));
      expect(session.providers).toContainEqual(expect.objectContaining({ id: 'anthropic' }));

      await jsonMutation(user, 'PUT', '/api/hosted/provider', {
        provider: 'anthropic',
        key: context.provider.credential('a'),
      });
      const project = await jsonMutation<ProjectResponse>(user, 'POST', '/api/projects', {
        title: 'Hosted core project',
        kind: 'prototype',
      });
      const conversation = await jsonMutation<ConversationResponse>(
        user,
        'POST',
        `/api/projects/${project.project.id}/conversations`,
        { title: 'Hosted core conversation', sessionMode: 'design' },
      );
      await jsonMutation(
        user,
        'PUT',
        `/api/projects/${project.project.id}/conversations/${conversation.conversation.id}/messages/${HOSTED_ASSISTANT_MESSAGE_ID}`,
        { role: 'assistant', content: '' },
      );

      const run = await startRun(
        user,
        project.project.id,
        conversation.conversation.id,
        'hosted-core-run',
        '[tenant-a-marker] Hosted core turn',
      );
      await waitForRun(user, run.runId, 'succeeded');

      const html = '<!doctype html><h1>Hosted core preview</h1>';
      await jsonMutation(user, 'POST', `/api/projects/${project.project.id}/files`, {
        name: 'index.html',
        content: html,
      });
      expect(await readText(user, `/api/projects/${project.project.id}/files/index.html`))
        .toBe(html);
      const previewResponse = await user.request(
        `/api/projects/${project.project.id}/preview-url`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: 'index.html' }),
        },
      );
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as PreviewResponse;
      expect(preview).toMatchObject({ opaqueOrigin: true, iframeSandbox: 'allow-scripts' });
      const cookie = previewResponse.headers.get('set-cookie')?.split(';', 1)[0];
      expect(cookie).toEqual(expect.any(String));
      const rendered = await fetch(new URL(preview.url, context.daemonUrl), {
        headers: { cookie: cookie! },
      });
      expect(rendered.status).toBe(200);
      expect(await rendered.text()).toBe(html);
    });
  }, 600_000);
});
