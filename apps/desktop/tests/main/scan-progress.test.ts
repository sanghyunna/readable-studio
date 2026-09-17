import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { readDaemonScan } from '../../src/main/scan-progress.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

it.each([
  { scan: null },
  { scan: { phase: 'running', currentAgentId: 'kimi', currentAgentName: 'Kimi', completed: 1, total: 2 } },
])('reads progress over the discovered daemon HTTP surface', async (payload) => {
  // Given
  const paths: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  servers.push(server);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Expected TCP listener');
  // When
  const result = await readDaemonScan(async () => `http://127.0.0.1:${address.port}`);
  // Then
  expect(result).toEqual(payload.scan === null ? null : {
    phase: 'running', currentAgentName: 'Kimi', completed: 1, total: 2,
  });
  expect(paths).toEqual(['/api/agents/scan']);
});

it('rejects unreachable discovery instead of reporting stored completion', async () => {
  // Given
  const discover = async () => null;
  // When
  const result = readDaemonScan(discover);
  // Then
  await expect(result).rejects.toHaveProperty('name', 'Error');
});
