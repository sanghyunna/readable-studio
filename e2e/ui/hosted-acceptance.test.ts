import { expect, test } from '@playwright/test';
import type { HostedMessagesResponse, HostedSessionResponse } from '@readable-studio/contracts';

import { createSmokeSuite } from '@/smoke-suite';
import { T } from '@/timeouts';

test('[P0] hosted composition accepts a credential and edits owned project content', async ({ page }) => {
  test.setTimeout(T.xlong * 2);
  const suite = await createSmokeSuite('hosted-browser');

  await suite.with.hosted(async (hosted) => {
    const user = hosted.identity('a');
    await page.context().addCookies([{
      name: '__Host-readable-hosted',
      value: 'a',
      domain: new URL(hosted.webUrl).hostname,
      path: '/',
      secure: true,
    }]);
    const sessionResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/hosted/session',
      { timeout: T.long },
    );
    const providerResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/hosted/provider',
      { timeout: T.long },
    );
    await page.goto(hosted.webUrl);

    const session = await sessionResponse;
    expect(session.status()).toBe(200);
    expect((await session.json() as HostedSessionResponse).publicOrigin).toBe(hosted.webUrl);
    expect((await providerResponse).status()).toBe(200);

    await expect(page.getByRole('heading', { name: 'Connect a model provider' }))
      .toBeVisible({ timeout: T.long });
    await page.getByLabel('API key').fill(hosted.provider.credential('a'));
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Key saved for this session.' }))
      .toBeVisible();

    await page.getByLabel('Project name').fill('Hosted browser acceptance');
    await page.getByRole('button', { name: 'Create project' }).click();
    const projectSelect = page.getByRole('combobox', { name: 'Project', exact: true });
    await expect(projectSelect).not.toHaveValue('');
    const projectId = await projectSelect.inputValue();
    expect(projectId).not.toBe('');
    await page.getByLabel('Conversation title').fill('Hosted browser conversation');
    await page.getByRole('button', { name: 'Create conversation' }).click();
    const conversationSelect = page.getByRole('combobox', { name: 'Conversation', exact: true });
    await expect(conversationSelect).not.toHaveValue('');
    const conversationId = await conversationSelect.inputValue();
    await page.getByLabel('Prompt').fill('[tenant-a-marker] Hosted browser UI turn');
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Run completed.' }))
      .toBeVisible({ timeout: T.xlong });
    const { messages } = await user.json<HostedMessagesResponse>(
      `/api/projects/${projectId}/conversations/${conversationId}/messages`,
    );
    expect(messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Hosted acceptance complete.',
      runStatus: 'succeeded',
      lastRunEventId: expect.any(String),
    }));

    await page.getByLabel('Prompt').fill('[tenant-a-marker] [hold-for-cancel] Cancel this turn');
    await page.getByRole('button', { name: 'Start run' }).click();
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Run canceled.' }))
      .toBeVisible({ timeout: T.long });

    await page.getByLabel('Project ID').fill(projectId);
    await page.getByRole('button', { name: 'Open project' }).click();
    await expect(page.getByText('No files yet.')).toBeVisible();

    const maliciousHtml = `<!doctype html>
<form action="/api/hosted/provider" method="post"></form>
<script>
try { void fetch('/api/hosted/provider', { method: 'DELETE' }); } catch {}
try { new WebSocket('ws://' + location.host + '/api/hosted/provider'); } catch {}
try { parent.postMessage({ type: 'readable-studio:file-save', path: 'index.html', content: 'forged' }, '*'); } catch {}
try { document.forms[0].submit(); } catch {}
try { top.location = '/api/hosted/provider'; } catch {}
</script>
<h1>Hosted browser acceptance</h1>`;
    await page.getByLabel('File path').fill('index.html');
    await page.getByRole('textbox', { name: 'Content', exact: true })
      .fill(maliciousHtml);
    await page.getByRole('button', { name: 'Save file' }).click();
    await expect(page.getByRole('button', { name: /index\.html/u })).toBeVisible();

    const providerMutations: string[] = [];
    const providerSockets: string[] = [];
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname === '/api/hosted/provider'
        && request.method() !== 'GET'
      ) providerMutations.push(request.method());
    });
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname === '/api/hosted/provider') {
        providerSockets.push(socket.url());
      }
    });
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(
      page.frameLocator('iframe[title="Preview of index.html"]')
        .getByRole('heading', { name: 'Hosted browser acceptance' }),
    ).toBeVisible();
    expect(page.url()).toBe(new URL('/', hosted.webUrl).href);
    expect(providerMutations).toEqual([]);
    expect(providerSockets).toEqual([]);
    expect(await page.evaluate(async () => {
      const response = await fetch('/api/hosted/provider');
      return { status: response.status, body: await response.json() as unknown };
    })).toEqual({
      status: 200,
      body: { configured: true, provider: 'anthropic' },
    });
    expect(await page.evaluate(async (path) => {
      const response = await fetch(path);
      return { status: response.status, body: await response.text() };
    }, `/api/projects/${projectId}/files/index.html`)).toEqual({
      status: 200,
      body: maliciousHtml,
    });
  });
});
