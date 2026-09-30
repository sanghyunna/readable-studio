import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { DatabricksScanResponse } from '@readable-studio/contracts';
import { createDatabricksService, type DatabricksService } from '../../src/databricks/service.js';
import { withDeadline } from '../../src/databricks/client.js';
import type { DatabricksFetch } from '../../src/databricks/scan.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const chatStream = (tools = false): Response => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: tools
  ? { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'readable_probe', arguments: '{"ok":true}' } }] }
  : { content: 'OK' }, finish_reason: tools ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
export async function namedFixture(fetch: DatabricksFetch) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'readable-named-')); roots.push(dataRoot);
  const options = { dataRoot, fetch, clientOptions: { resolveExecutable: async () => 'C:\\test\\databricks.exe',
    runner: async (_executable: string, args: readonly string[]) => ({ stderr: '', exitCode: 0, stdout: args[0] === '--version' ? 'Databricks CLI v0.278.0'
      : args[1] === 'profiles' ? JSON.stringify({ profiles: [{ name: 'test', host: 'https://workspace.example' }] })
        : JSON.stringify({ access_token: 'test-token', expiry: '2099-01-01T00:00:00Z' }) }) } };
  const service = createDatabricksService(options);
  const profileId = (await service.probe()).profiles[0]?.id;
  if (!profileId) throw new Error('Missing profile');
  return { service, profileId, dataRoot, restart: () => createDatabricksService(options) };
}
export async function completed(service: DatabricksService, scanId: string): Promise<DatabricksScanResponse> {
  let resolve: (scan: DatabricksScanResponse) => void = () => { throw new Error('Completion not initialized'); };
  const result = new Promise<DatabricksScanResponse>(done => { resolve = done; });
  const unsubscribe = await service.subscribeScan(scanId, event => { if (event.type === 'done') resolve(event.scan); });
  try { return await withDeadline(() => result, 5000); } finally { unsubscribe(); }
}
