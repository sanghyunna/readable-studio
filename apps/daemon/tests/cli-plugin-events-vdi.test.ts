import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

test('non-follow plugin tail waits for a delayed complete snapshot', async () => {
  const routes: string[] = [];
  const event = { id: 7, at: 1, kind: 'plugin.installed', pluginId: 'slow-disk', details: {} };
  const server = createServer((req, res) => {
    routes.push(req.url ?? '');
    if (req.url?.startsWith('/api/plugins/events/snapshot')) {
      res.setHeader('content-type', 'application/json');
      setTimeout(() => res.end(JSON.stringify({ events: [event] })), 500);
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => res.end(`event: backlog\ndata: ${JSON.stringify(event)}\n\n`), 500);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  try {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const result = await promisify(execFile)(process.execPath, [tsx, cli, 'plugin', 'events', 'tail', '--json', '--since', '3', '--daemon-url', `http://127.0.0.1:${address.port}`], { env: process.env, timeout: 15_000, windowsHide: true });
    expect(routes).toEqual(['/api/plugins/events/snapshot?since=3']);
    expect(JSON.parse(result.stdout)).toMatchObject({ channel: 'backlog', ...event });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
