import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { CODEX_FALLBACK_RETRY_RUN as fixture, createFakeAgentRuntimes, GLOBAL_RETRY_RUN } from '@/fake-agents';

type Frame = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
type Attempt = { attempt: number; startedAt: number; args: string[]; isolated: boolean; CODEX_HOME: string; method: string; sessionId: string };
let root: string, project: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-retry-fixture-'));
  project = join(root, 'project');
  await mkdir(project);
  await createFakeAgentRuntimes({ root: join(root, 'bin'), runtimeIds: ['codex'] });
  await writeFile(join(project, fixture.armFile), fixture.armToken);
});
afterEach(async () => {
  expect(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true);
  await rm(root, { recursive: true, force: true });
});

async function peer(options: { isolated?: boolean; resume?: boolean; discovery?: boolean } = {}) {
  const requests: Frame[] = [], frames: Frame[] = [];
  const child = spawn(process.execPath, [join(root, 'bin', 'codex-e2e.cjs'), 'app-server', '--listen', 'stdio://'], {
    cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    env: { ...process.env, READABLE_PROJECT_DIR: project,
      READABLE_ISOLATED_TOOL_BROKER_PIPE: options.isolated ? 'fixture-isolated-pipe' : '',
      CODEX_HOME: join(root, options.isolated ? 'isolated-home' : 'normal-home') },
  });
  let stdout = '', stderr = '', protocolError: unknown;
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  const send = (message: Frame) => {
    requests.push(message);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const frame: Frame = JSON.parse(line);
      frames.push(frame);
      if (frame.id === 1 && frame.result) {
        send({ method: 'initialized', params: {} });
        send(options.discovery ? { id: 2, method: 'account/read', params: {} } : {
          id: 2, method: options.resume ? 'thread/resume' : 'thread/start',
          params: { model: 'gpt-5.4-mini', cwd: project, approvalPolicy: 'never',
            ...(options.resume ? { threadId: fixture.threadId } : { ephemeral: false }) },
        });
      }
      if (frame.id === 2 && frame.result) send(options.discovery
        ? { id: 3, method: 'model/list', params: {} }
        : { id: 3, method: 'turn/start', params: { threadId: fixture.threadId,
          input: [{ type: 'text', text: fixture.prompt }] } });
      if ((options.discovery && frame.id === 3) || frame.method === 'turn/completed') child.stdin.end();
    } catch (error) { protocolError = error; child.kill(); }
  });
  try {
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'retry-fixture', version: '1' } } });
    const code = await closed;
    if (protocolError) throw protocolError;
    return { code, stdout, stderr, requests, frames };
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
  }
}

async function attempts(): Promise<Attempt[]> {
  return (await readFile(join(project, fixture.ledgerFile), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
const text = (frames: Frame[]) => frames.filter(frame => frame.method === 'item/agentMessage/delta')
  .map(frame => frame.params?.delta).join('');

test('reports only the recognized CODEX_HOME startup diagnostic before any RPC output', async () => {
  const result = await peer({ isolated: true });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  const diagnostic = result.stderr.trim().split(/\r?\n/);
  expect(diagnostic).toHaveLength(2);
  expect(diagnostic[0]).toMatch(/^WARNING: proceeding, even though we could not create PATH aliases: failed to canonicalize CODEX_HOME .+\(os error 5\)$/);
  expect(diagnostic[1]).toMatch(/^(?:Error finding codex home: failed to canonicalize CODEX_HOME .+|Error: .+)\(os error 5\)$/);
  expect(await attempts()).toEqual([expect.objectContaining({ attempt: 1, isolated: true, method: 'initialize', sessionId: '' })]);
});

test('recovers outside isolation, preserves committed work, and replays the prefix only on native resume', async () => {
  await peer({ isolated: true });
  const failed = await peer();
  expect(text(failed.frames)).toBe(GLOBAL_RETRY_RUN.partial);
  expect(failed.frames).toContainEqual(expect.objectContaining({ method: 'turn/completed',
    params: { turn: expect.objectContaining({ status: 'failed', error: expect.objectContaining({ message: expect.stringContaining('503') }) }) } }));
  expect(failed.frames).toContainEqual(expect.objectContaining({ method: 'item/started',
    params: { item: expect.objectContaining({ type: 'commandExecution' }) } }));
  expect(await readFile(join(project, fixture.toolFile), 'utf8')).toBe('saved once\n');

  const resumed = await peer({ resume: true });
  expect(resumed.code).toBe(0);
  expect(resumed.stderr).toBe('');
  expect(resumed.requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
  expect(text(resumed.frames)).toBe(`${GLOBAL_RETRY_RUN.partial}${GLOBAL_RETRY_RUN.continuation}\n<!-- readable:no-document-required reason="question" -->`);
  expect(resumed.frames).toContainEqual({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  expect(resumed.frames.filter(frame => frame.method === 'item/started')).toEqual([]);
  expect(await readFile(join(project, fixture.toolFile), 'utf8')).toBe('saved once\n');
  const ledger = await attempts();
  expect(ledger.map(row => row.attempt)).toEqual([1, 2, 3]);
  expect(ledger.map(row => row.isolated)).toEqual([true, false, false]);
  expect(ledger.map(row => row.method)).toEqual(['initialize', 'thread/start', 'thread/resume']);
  expect(ledger.map(row => row.sessionId)).toEqual(['', fixture.threadId, fixture.threadId]);
  expect(ledger.every(row => row.args[0] === 'app-server' && row.startedAt > 0)).toBe(true);
  expect(ledger[0]!.CODEX_HOME).not.toBe(ledger[1]!.CODEX_HOME);
});

test('keeps discovery usable when a project is not armed with the exact fixture token', async () => {
  await writeFile(join(project, fixture.armFile), `${fixture.armToken}\n`);
  const result = await peer({ isolated: true, discovery: true });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'account/read', 'model/list']);
  expect(result.frames.find(frame => frame.id === 2)?.result).toEqual({ account: { type: 'apiKey' } });
  expect(result.frames.find(frame => frame.id === 3)?.result).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.4-mini' })]) });
  await expect(attempts()).rejects.toMatchObject({ code: 'ENOENT' });
});
