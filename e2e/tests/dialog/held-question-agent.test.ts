import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFakeAgentRuntimes, HELD_QUESTION_RUN } from '@/fake-agents';

// Static fixture contract tests: execute the generated script in a VM with
// event-driven stdin/fs/process doubles. No child, daemon, browser or timers run.
// fs.watch and readFile are separate: callbacks cannot invent a matching signal.
let root: string;
let script: Script;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'held-question-static-'));
  await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
  script = new Script(await readFile(join(root, 'codex-e2e.cjs'), 'utf8'));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function fixture(existingSignal?: string) {
  const stdin = Object.assign(new EventEmitter(), {
    setEncoding() {}, resume() {}, isTTY: false,
  });
  const frames: Array<{ type: string; item?: { type: string; text: string } }> = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  let signal = existingSignal;
  let readError: Error | undefined;
  let watchCallback: ((event: string, filename: string | null) => void) | undefined;
  let watchedDirectory: string | undefined;
  let closed = false;
  const watcher = Object.assign(new EventEmitter(), { close: () => { closed = true; } });
  const processDouble = Object.assign(new EventEmitter(), {
    argv: ['node', 'codex-e2e.cjs'], stdin,
    cwd: () => root,
    stdout: { write: (text: string, callback?: () => void) => {
      for (const line of text.split('\n').filter(Boolean)) frames.push(JSON.parse(line));
      callback?.();
      return true;
    } },
    stderr: { write: (text: string) => { stderr.push(text); return true; } },
    exit: (code: number) => { exits.push(code); },
    exitCode: undefined as number | undefined,
  });
  script.runInNewContext({
    process: processDouble,
    require: (name: string) => {
      if (name === 'node:path') return { join };
      if (name === 'node:fs/promises') return {};
      if (name === 'node:fs') return {
        existsSync: (file: string) => {
          expect(file).toBe(join(root, HELD_QUESTION_RUN.releaseFile));
          return signal !== undefined;
        },
        readFileSync: (file: string, encoding: string) => {
          expect(file).toBe(join(root, HELD_QUESTION_RUN.releaseFile));
          expect(encoding).toBe('utf8');
          if (readError) throw readError;
          if (signal === undefined) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
          return signal;
        },
        watch: (directory: string, callback: typeof watchCallback) => {
          watchedDirectory = directory;
          watchCallback = callback;
          return watcher;
        },
      };
      throw new Error(`Unexpected fixture import: ${name}`);
    },
    setTimeout: (callback: () => void, ms: number) => {
      const id = ++timerId;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  return {
    stdin, frames, exits, stderr, timers, watcher, processDouble,
    start(prompt = `## user\n${HELD_QUESTION_RUN.prompt}`) {
      stdin.emit('data', prompt);
      stdin.emit('end');
    },
    signal(content: string | undefined, filename: string | null = HELD_QUESTION_RUN.releaseFile) {
      signal = content;
      if (!watchCallback || closed) throw new Error('Signal requires an active watcher');
      watchCallback('change', filename);
    },
    failRead(error: Error) { readError = error; },
    fireTimeout(ms: number) {
      const timer = [...timers.entries()].filter(([, value]) => value.ms === ms);
      expect(timer).toHaveLength(1);
      const [id, value] = timer[0]!;
      timers.delete(id);
      value.callback();
    },
    isClosed: () => closed,
    watchedDirectory: () => watchedDirectory,
  };
}

function assertHeld(value: ReturnType<typeof fixture>) {
  expect(value.frames.map((frame) => frame.type)).toEqual(['thread.started', 'turn.started', 'item.completed']);
  expect(value.exits).toEqual([]);
  expect(value.isClosed()).toBe(false);
  expect(value.watchedDirectory()).toBe(root);
}
function assertClean(value: ReturnType<typeof fixture>) {
  expect(value.isClosed()).toBe(true);
  expect(value.processDouble.listenerCount('SIGTERM')).toBe(0);
  expect(value.processDouble.listenerCount('SIGINT')).toBe(0);
  expect([...value.timers.values()].some((timer) => timer.ms === HELD_QUESTION_RUN.timeoutMs)).toBe(false);
}

describe('held question Codex fixture', () => {
  test('reads the complete stdin transcript, emits required JSON, and releases exactly once', () => {
    const value = fixture();
    value.stdin.emit('data', '## user\n');
    value.stdin.emit('data', HELD_QUESTION_RUN.prompt);
    expect(value.frames).toEqual([]);
    expect(value.timers.size).toBe(0);
    value.stdin.emit('end');
    assertHeld(value);
    const form = value.frames[2]?.item;
    expect(form?.type).toBe('agent_message');
    const match = /^<question-form id="([^"]+)"[^>]*>(.*)<\/question-form>$/.exec(form!.text);
    expect(match?.[1]).toBe(HELD_QUESTION_RUN.formId);
    const parsed = JSON.parse(match![2]!);
    expect(parsed).toEqual(HELD_QUESTION_RUN.form);
    expect(parsed.questions.every((question: { required: boolean }) => question.required)).toBe(true);
    value.signal(HELD_QUESTION_RUN.releaseToken);
    expect(value.frames.filter((frame) => frame.type === 'turn.completed')).toHaveLength(1);
    expect(value.exits).toEqual([0]);
    assertClean(value);
    value.stdin.emit('end');
    expect(value.frames.filter((frame) => frame.type === 'turn.completed')).toHaveLength(1);
  });

  test('ignores unrelated files, absent files, partial tokens, and trailing newlines', () => {
    const value = fixture();
    value.start();
    value.signal(undefined);
    value.signal(HELD_QUESTION_RUN.releaseToken, 'unrelated.release');
    value.signal(HELD_QUESTION_RUN.releaseToken.slice(0, -1));
    value.signal(`${HELD_QUESTION_RUN.releaseToken}\n`);
    assertHeld(value);
    value.signal(HELD_QUESTION_RUN.releaseToken, null);
    expect(value.exits).toEqual([0]);
    assertClean(value);
  });

  test('does not rearm from an earlier user sentinel in the promoted answer transcript', () => {
    const value = fixture();
    value.start(`## user\n${HELD_QUESTION_RUN.prompt}\n\n## assistant\n[prior form]\n\n## user\n[form answers \u2014 ${HELD_QUESTION_RUN.formId}]\n- Delivery target: Desktop web [value: desktop-web]`);
    expect(value.watchedDirectory()).toBeUndefined();
    expect(value.frames.filter((frame) => frame.type === 'turn.completed')).toHaveLength(1);
    expect(value.frames.some((frame) => frame.item?.text.includes('<question-form'))).toBe(false);
  });

  test.each(['SIGTERM', 'SIGINT'])('%s cancels without emitting successful completion', (signal) => {
    const value = fixture();
    value.start();
    value.processDouble.emit(signal);
    expect(value.exits).toEqual([143]);
    expect(value.frames.some((frame) => frame.type === 'turn.completed')).toBe(false);
    assertClean(value);
  });

  test('bounded timeout and filesystem failures fail loudly and close the watcher', () => {
    for (const failure of ['timeout', 'watch', 'read'] as const) {
      const value = fixture();
      value.start();
      if (failure === 'timeout') value.fireTimeout(HELD_QUESTION_RUN.timeoutMs);
      if (failure === 'watch') value.watcher.emit('error', new Error('watch failed'));
      if (failure === 'read') {
        value.failRead(Object.assign(new Error('read denied'), { code: 'EACCES' }));
        value.signal(HELD_QUESTION_RUN.releaseToken);
      }
      assertClean(value);
      expect(value.stderr).toHaveLength(1);
      expect(value.processDouble.exitCode).toBe(1);
      expect(value.frames.some((frame) => frame.type === 'turn.completed')).toBe(false);
    }
  });

  test('rejects a stale release file rather than passing without a held interval', async () => {
    const value = fixture(HELD_QUESTION_RUN.releaseToken);
    value.start();
    // emitRun's rejected promise reports through its registered catch handler.
    await Promise.resolve();
    expect(value.frames).toEqual([]);
    expect(value.stderr).toHaveLength(1);
    expect(value.processDouble.exitCode).toBe(1);
    expect(value.watchedDirectory()).toBeUndefined();
  });
});
