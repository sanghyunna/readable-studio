import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createFakeAgentRuntimes, GLOBAL_RETRY_RUN } from '@/fake-agents';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'global-retry-fixture-'));
  await createFakeAgentRuntimes({ root, runtimeIds: ['claude'] });
});
afterEach(async () => {
  expect(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true);
  await rm(root, { recursive: true, force: true });
});

async function invoke(prompt: string, args: string[] = []) {
  const child = spawn(process.execPath, [join(root, 'claude-e2e.cjs'), ...args], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  child.stdin.end(`## user\n${prompt}`);
  const code = await exited;
  return { code, stderr, frames: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

async function attempts(scenario: keyof typeof GLOBAL_RETRY_RUN.prompts) {
  return (await readFile(join(root, `${GLOBAL_RETRY_RUN.ledgerPrefix}${scenario}.jsonl`), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
}

describe('global retry Claude fixture', () => {
  test('uses a substantial multiline delivered prefix for conservative replay matching', () => {
    expect(GLOBAL_RETRY_RUN.partial.length).toBeGreaterThanOrEqual(32);
    expect(GLOBAL_RETRY_RUN.partial).toContain('\n');
  });

  test('emits a partial answer, then replays the prefix on a native resumed success', async () => {
    const first = await invoke(GLOBAL_RETRY_RUN.prompts.transient, ['--session-id', 'retry-session']);
    expect(first.code).toBe(1);
    expect(first.stderr).toBe('');
    expect(first.frames).toContainEqual(expect.objectContaining({ type: 'system', session_id: 'retry-session' }));
    expect(first.frames).toContainEqual(expect.objectContaining({
      type: 'stream_event', event: expect.objectContaining({ delta: { type: 'text_delta', text: GLOBAL_RETRY_RUN.partial } }),
    }));
    expect(first.frames).toContainEqual(expect.objectContaining({ type: 'assistant', error: 'ECONNRESET' }));
    const second = await invoke(GLOBAL_RETRY_RUN.prompts.transient, ['--resume', 'retry-session']);
    expect(second.code).toBe(0);
    const text = second.frames.find(frame => frame.type === 'assistant')?.message.content[0].text;
    expect(text).toBe(`${GLOBAL_RETRY_RUN.partial}${GLOBAL_RETRY_RUN.continuation}\n<!-- readable:no-document-required reason="question" -->`);
    expect(second.frames.find(frame => frame.type === 'system')?.session_id).toBe('retry-session');
    const ledger = await attempts('transient');
    expect(ledger.map(item => item.attempt)).toEqual([1, 2]);
    expect(ledger.map(item => item.sessionId)).toEqual(['retry-session', 'retry-session']);
    expect(ledger[1].args).toContain('--resume');
    expect(ledger[1].startedAt).toBeGreaterThanOrEqual(ledger[0].startedAt);
  });

  test('never turns an exhausted transient scenario into success on its eleventh execution', async () => {
    for (let index = 0; index < 11; index++) {
      const result = await invoke(GLOBAL_RETRY_RUN.prompts.exhausted);
      expect(result.code).toBe(1);
      expect(result.frames).toContainEqual(expect.objectContaining({ type: 'assistant', error: '503' }));
      expect(result.frames.some(frame => frame.type === 'stream_event')).toBe(false);
    }
    expect((await attempts('exhausted')).map(item => item.attempt)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
  });

  test.each(['quota', 'invalid-model'] as const)('emits the terminal %s provider error on the first execution', async scenario => {
    const result = await invoke(GLOBAL_RETRY_RUN.prompts[scenario]);
    expect(result.code).toBe(1);
    expect(result.frames.find(frame => frame.type === 'assistant')?.message.content[0].text)
      .toBe(GLOBAL_RETRY_RUN.failures[scenario]);
    expect((await attempts(scenario)).map(item => item.attempt)).toEqual([1]);
  });

  test('does not arm a retry case from an earlier user turn', async () => {
    const result = await invoke(`${GLOBAL_RETRY_RUN.prompts.transient}\n\n## assistant\nPrevious answer.\n\n## user\nOrdinary next turn.`);
    expect(result.code).toBe(0);
    await expect(attempts('transient')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not count background memory extraction containing a prior sentinel', async () => {
    const result = await invoke(GLOBAL_RETRY_RUN.prompts.transient, ['--output-format', 'text']);
    expect(result.code).toBe(0);
    expect(result.frames).toEqual([{}]);
    await expect(attempts('transient')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
