import { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { attachCodexAppServerSession } from '../src/runtimes/codex-app-server.js';

it('replays Codex occupancy, compaction and foreign thread events through the production adapter', () => {
  const child = Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const events: Record<string, unknown>[] = [];
  const session = attachCodexAppServerSession({ child, cwd: process.cwd(), model: 'fixture-model', prompt: 'fixture', onEvent: event => events.push(event) });
  const receive = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`);
  try {
    receive({ id: 1, result: {} });
    receive({ id: 2, result: { thread: { id: 'thread' } } });
    receive({ id: 3, result: { turn: { id: 'turn' } } });
    child.stdout.write(readFileSync(new URL('../../../mocks/fixtures/context-usage/codex-app-server.jsonl', import.meta.url), 'utf8'));
    receive({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    const snapshots = events.filter(event => event.type === 'context_usage').map(event => event.snapshot);
    expect(snapshots).toEqual([
      expect.objectContaining({ state: 'measured', usedTokens: 284_000, limitTokens: 500_000, model: 'fixture-model', sessionId: 'thread' }),
      expect.objectContaining({ state: 'unknown', usedTokens: null, reason: 'compacting' }),
      expect.objectContaining({ state: 'unknown', usedTokens: null, reason: 'compacted' }),
      expect.objectContaining({ state: 'measured', usedTokens: 20_000, limitTokens: 500_000 }),
    ]);
    expect(session.completedSuccessfully()).toBe(true);
  } finally { child.emit('close', 0, null); }
});
