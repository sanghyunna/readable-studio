import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabricksClient, resolveDatabricksCli, type DatabricksSubprocessRunner } from '../../src/databricks/client.js';
import { probeNamed } from '../../src/databricks/named-probe.js';
import { requestJson, scanWorkspace, type WorkspaceScanOptions } from '../../src/databricks/scan.js';
import { chatStream } from './named-fixture.js';

afterEach(() => vi.useRealTimers());
const binding = { id: 'fixture', profileName: 'DEFAULT', host: 'https://workspace.example', isDefault: true };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

it('allows a cold CLI candidate and command to finish after the old deadlines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'databricks-vdi-'));
  const executable = join(root, 'databricks.exe');
  await writeFile(executable, 'fixture');
  vi.useFakeTimers();
  const runner: DatabricksSubprocessRunner = async () => {
    await pause(31_000);
    return { stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 };
  };
  try {
    const candidate = resolveDatabricksCli(undefined, { runner, env: { PATH: root }, userToolchainBins: [] });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(31_001);
    expect(await candidate).toMatchObject({ path: executable });
    const client = new DatabricksClient({ resolveExecutable: async () => 'databricks.exe', runner });
    const probe = client.probe();
    await vi.advanceTimersByTimeAsync(31_001);
    expect(await probe).toMatchObject({ cli: 'ready' });
  } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
});

it('allows a slow metadata response and a paginated scan beyond one minute', async () => {
  vi.useFakeTimers();
  const workspace: WorkspaceScanOptions = { binding, bearer: 'fixture', scopeNames: [], fetch: async url => {
    await pause(70_000);
    return Response.json(url.includes('page_token=next') ? { endpoints: [] } : { endpoints: [], next_page_token: 'next' });
  } };
  const metadata = requestJson(workspace, '/api/2.0/serving-endpoints').catch(error => error);
  await vi.advanceTimersByTimeAsync(70_001);
  expect(await metadata).toEqual({ endpoints: [], next_page_token: 'next' });
  const scan = scanWorkspace(workspace);
  await vi.advanceTimersByTimeAsync(140_001);
  expect(await scan).toMatchObject({ completeness: { serving: true, uc: true, truncated: false }, issues: [] });
});

it('lets named metadata and inference each finish slowly without an earlier outer cutoff', async () => {
  vi.useFakeTimers();
  const result = probeNamed({ name: 'slow-model', request: { profileId: 'fixture', names: 'slow-model', allowInference: true, kindHint: 'serving-endpoint' },
    onAttempt() {}, workspace: { binding, bearer: 'fixture', fetch: async (_url, init) => {
      await pause(90_000);
      return init.method === 'POST' ? chatStream(true) : Response.json({ name: 'slow-model', task: 'llm/v1/chat' });
    } } }).catch(error => error);
  await vi.advanceTimersByTimeAsync(180_001);
  expect(await result).toMatchObject({ checks: { streaming: 'passed', tools: 'passed' } });
});

it('still cancels a slow metadata request immediately', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  const result = requestJson({ binding, bearer: 'fixture', signal: controller.signal, fetch: async (_url, init) => {
    signal = init.signal; return new Promise(() => {});
  } }, '/api/2.0/serving-endpoints').catch(error => error);
  controller.abort();
  expect(await result).toMatchObject({ diagnostic: { category: 'aborted' } });
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
