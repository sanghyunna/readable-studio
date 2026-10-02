import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const requests: Record<string, unknown>[] = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url === '/api/runs' && req.method === 'POST') requests.push(JSON.parse(body));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ runId: 'fixture-run', ok: true }));
});
let baseUrl: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('CLI redesign design-system selection', () => {
  it.each([null, 'default'])('sends %s only when chosen', async (choice) => {
    const env: NodeJS.ProcessEnv = { ...process.env, READABLE_DAEMON_URL: baseUrl };
    delete env.NODE_OPTIONS;
    await execute(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'run', 'redesign', '--project', 'fixture-project', '--json',
      ...(choice ? ['--design-system', choice] : []),
    ], { env, timeout: 20_000 });
    expect(requests.at(-1)?.designSystemId).toBe(choice);
  });
});
