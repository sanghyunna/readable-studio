import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createJsonEventStreamHandler } from '../src/json-event-stream.js';

const fixture = new URL('../../../mocks/fixtures/cursor-agent/thinking-tool-segments.jsonl', import.meta.url);
const frames = readFileSync(fixture, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

function replay(input: Record<string, unknown>[], chunkSize = Infinity) {
  const events: Record<string, unknown>[] = [];
  const parser = createJsonEventStreamHandler('cursor-agent', event => events.push(event));
  const stream = input.map(frame => JSON.stringify(frame)).join('\n') + '\n';
  for (let offset = 0; offset < stream.length; offset += chunkSize) parser.feed(stream.slice(offset, offset + chunkSize));
  parser.flush();
  return events;
}

function text(events: Record<string, unknown>[], type = 'text_delta') {
  return events.filter(event => event.type === type).map(event => event.delta).join('');
}

function assistant(value: string, timestamp = true, model?: string) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: value }] },
    ...(timestamp ? { timestamp_ms: 1 } : {}), ...(model ? { model_call_id: model } : {}) };
}

const result = { type: 'result', result: 'AB', subtype: 'success' };

describe('Cursor native stream replay', () => {
  it.each([1, 17, Infinity])('renders AB, not ABB, across tool segments with transport chunks of %s bytes', chunkSize => {
    expect(text(replay(frames, chunkSize))).toBe('AB');
  });

  it('surfaces the exact vendor thinking deltas on the existing thinking channel', () => {
    const events = replay(frames);
    expect(text(events, 'thinking_delta')).toBe('Plan A.Plan B.');
    expect(events.filter(event => event.type === 'thinking_start')).toHaveLength(2);
    expect(events.some(event => event.type === 'raw' && String(event.line).includes('"type":"thinking"'))).toBe(false);
  });

  it('duplicates neither segment when thinking is absent', () => {
    expect(text(replay(frames.filter(frame => frame.type !== 'thinking')))).toBe('AB');
  });

  it('does not reset the text segment at a thinking boundary', () => {
    expect(text(replay([assistant('A'), { type: 'thinking', subtype: 'delta', text: 'Plan.' },
      { type: 'thinking', subtype: 'completed' }, assistant('B'), assistant('AB', false), result]))).toBe('AB');
  });

  it.each(['tool_call', 'retry', 'interaction_query'])('deduplicates a timestamped snapshot flushed before %s', type => {
    const boundary = { type, subtype: type === 'tool_call' ? 'started' : type === 'interaction_query' ? 'request' : 'starting' };
    expect(text(replay([assistant('A'), assistant('A'), boundary, assistant('B'), assistant('B'), boundary, result]))).toBe('AB');
  });

  it('renders each untimestamped final-only segment even when the text repeats', () => {
    expect(text(replay([assistant('A', false), assistant('A', false), result]))).toBe('AA');
  });

  it('preserves identical and prefix-sharing incremental deltas rather than treating them as snapshots', () => {
    expect(text(replay([assistant('A'), assistant('A'), assistant('AA'), assistant('AAAA', false), result]))).toBe('AAAA');
  });

  it('emits only the unstreamed suffix of each final and never appends result text', () => {
    expect(text(replay([assistant('A'), assistant('A!', false), assistant('B'), assistant('B!', false),
      { ...result, result: 'A!B!' }]))).toBe('A!B!');
  });

  it('flushes a repeated last incremental delta when the CLI exits without a result', () => {
    expect(text(replay([assistant('A'), assistant('A')]))).toBe('AA');
  });

  it('replays the mocks fixture through native stdout into the production parser', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', fileURLToPath(fixture)],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const events: Record<string, unknown>[] = [];
    const parser = createJsonEventStreamHandler('cursor-agent', event => events.push(event));
    parser.feed(child.stdout);
    parser.flush();
    expect(text(events)).toBe('AB');
    expect(text(events, 'thinking_delta')).toBe('Plan A.Plan B.');
  });
});
