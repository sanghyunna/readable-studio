import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { attachCodexAppServerSession } from '../src/runtimes/codex-app-server.js';

const capture = readFileSync(new URL('../../../mocks/fixtures/thinking-claude-codex/codex-luna-index.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const reasoning = capture.filter(frame => frame.method === 'item/completed' && frame.params.item.type === 'reasoning');
const expected = reasoning.flatMap(frame => frame.params.item.summary).join('\n\n');
async function replay(frames: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-reasoning-replay-'));
  const path = join(dir, 'frames.json');
  writeFileSync(path, JSON.stringify(frames));
  const peer = `const frames=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));
    const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize') send({id:m.id,result:{}});
      if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
      if(m.method==='turn/start') {send({id:m.id,result:{turn:{id:'turn'}}});for(const frame of frames)send(frame);send({method:'turn/completed',params:{turn:{status:'completed'}}});}
    }).on('close',()=>process.exit(0));`;
  const child = spawn(process.execPath, ['-e', peer, path], { stdio: 'pipe', windowsHide: true });
  const closed = once(child, 'close', { signal: AbortSignal.timeout(10000) });
  const events: Record<string, unknown>[] = [];
  const session = attachCodexAppServerSession({ child, cwd: process.cwd(), model: 'gpt-6-luna', prompt: 'replay', onEvent: event => events.push(event) });
  try { await closed; } finally { if (child.exitCode === null) child.kill(); rmSync(dir, { recursive: true, force: true }); }
  expect(session.completedSuccessfully()).toBe(true);
  return events;
}
const thinking = (events: Record<string, unknown>[]) => events.filter(e => e.type === 'thinking_delta').map(e => e.delta).join('');

test('full real-wire replay matches the daemon-event golden consumed by web rendering tests', async () => {
  const events = await replay(capture.filter(frame => frame.method && frame.method !== 'turn/completed'));
  const golden = new URL('../../../mocks/golden/codex-luna-index.events.json', import.meta.url);
  if (process.env.MOCKS_GOLDEN_UPDATE === '1') writeFileSync(golden, JSON.stringify(events, null, 2) + '\n');
  expect(events).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
});

test('real gpt-6-luna wire preserves indexed summary boundaries without replaying completion', async () => {
  const frames = capture.filter(frame => frame.method?.startsWith('item/reasoning/') || (frame.method === 'item/completed' && frame.params.item.type === 'reasoning'));
  expect(thinking(await replay(frames))).toBe(expected);
});
test('same captured item resent with its deltas and completion appears once', async () => {
  const frames = capture.filter(frame => frame.method?.startsWith('item/reasoning/') || (frame.method === 'item/completed' && frame.params.item.type === 'reasoning'));
  expect(thinking(await replay([...frames, ...frames]))).toBe(expected);
});
test('completed-only captured reasoning still delivers every summary part once', async () => {
  expect(thinking(await replay([...reasoning, ...reasoning]))).toBe(expected);
});
const summaryDelta = (itemId: string, delta: string, summaryIndex = 0) => ({ method: 'item/reasoning/summaryTextDelta', params: { itemId, summaryIndex, delta } });
test('adjacent identical summaries in distinct items appear once without deduping chunks', async () => {
  expect(thinking(await replay([summaryDelta('one', 'same'), summaryDelta('one', 'same'), summaryDelta('two', 'same'), summaryDelta('two', 'same')]))).toBe('samesame');
});
test('attempt3 packaged SSE sequence loses only the adjacent duplicate summary', async () => {
  // SSE has no item IDs: assign distinct IDs to exercise the path identity dedupe cannot cover.
  const events = JSON.parse(readFileSync(new URL('../../../mocks/fixtures/thinking-claude-codex/codex-duplicate-attempt3.events.json', import.meta.url), 'utf8'));
  const frames = events.flatMap((event: Record<string, unknown>, index: number) => {
    if (event.type === 'thinking_delta') return [summaryDelta(`summary-${index}`, String(event.delta).replace(/^\n\n/, ''))];
    if (event.type === 'text_delta') return [{ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: event.delta } }];
    if (event.type === 'tool_use' || event.type === 'tool_result') return [{ method: event.type === 'tool_use' ? 'item/started' : 'item/completed', params: { item: { type: 'commandExecution', id: event.id ?? event.toolUseId, command: (event.input as { command: string } | undefined)?.command, aggregatedOutput: event.content, status: 'completed' } } }];
    return [];
  });
  const actual = (await replay(frames)).filter(event => event.type === 'thinking_delta' || event.type === 'text_delta');
  const expected = events.filter((event: Record<string, unknown>, index: number) => (event.type === 'thinking_delta' || event.type === 'text_delta') && index !== 3);
  expect(actual).toEqual(expected);
  const golden = new URL('../../../mocks/golden/codex-duplicate-attempt3.events.json', import.meta.url);
  if (process.env.MOCKS_GOLDEN_UPDATE === '1') writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n');
  expect(actual).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
});
test('trim-equal indexed summaries are suppressed; different prefix extensions and non-adjacent repeats stay', async () => {
  const frames = [summaryDelta('one', ' A '), summaryDelta('one', 'A', 1), summaryDelta('two', 'A'), summaryDelta('two', 'B'), summaryDelta('three', 'A')];
  expect(thinking(await replay(frames))).toBe(' A \n\nAB\n\nA');
});
test.each(['text', 'tool'])('a %s boundary permits an identical summary in the next thinking block', async boundary => {
  const separator = boundary === 'text'
    ? { method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'ANSWER_SENTINEL' } }
    : { method: 'item/started', params: { item: { type: 'commandExecution', id: 'tool', command: 'read' } } };
  const events = await replay([summaryDelta('one', 'A'), summaryDelta('two', 'A'), separator, summaryDelta('three', 'A')]);
  expect(events.filter(e => e.type === 'thinking_delta')).toEqual([{ type: 'thinking_delta', delta: 'A' }, { type: 'thinking_delta', delta: 'A' }]);
});
test('completed-only adjacent duplicates are suppressed but shorter different summaries are flushed', async () => {
  const complete = (id: string, summary: string[]) => ({ method: 'item/completed', params: { item: { type: 'reasoning', id, summary, content: [] } } });
  expect(thinking(await replay([complete('one', ['ALPHA']), complete('two', ['  ALPHA  ']), summaryDelta('three', 'AL'), complete('three', ['AL']), complete('four', ['ALPHA'])]))).toBe('ALPHA\n\nAL\n\nALPHA');
});
test('completion contributes only a missing suffix, not the already-streamed prefix', async () => {
  const frame = reasoning[0];
  const text = frame.params.item.summary[0];
  const delta = { method: 'item/reasoning/summaryTextDelta', params: { itemId: frame.params.item.id, summaryIndex: 0, delta: text.slice(0, 5) } };
  expect(thinking(await replay([delta, frame, frame]))).toBe(frame.params.item.summary.join('\n\n'));
});
test('raw-only reasoning completes once before assistant output', async () => {
  const delta = { method: 'item/reasoning/textDelta', params: { itemId: 'raw', contentIndex: 0, delta: 'RAW_SENTINEL' } };
  const complete = { method: 'item/completed', params: { item: { type: 'reasoning', id: 'raw', summary: [], content: ['RAW_SENTINEL'] } } };
  const answer = { method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'ANSWER_SENTINEL' } };
  const events = await replay([delta, complete, complete, answer]);
  expect(events.filter(e => e.type === 'thinking_delta' || e.type === 'text_delta')).toEqual([
    { type: 'thinking_delta', delta: 'RAW_SENTINEL' }, { type: 'text_delta', delta: 'ANSWER_SENTINEL' },
  ]);
});
test('summary wins over raw reasoning regardless of arrival order', async () => {
  const summary = capture.find(frame => frame.method === 'item/reasoning/summaryTextDelta');
  const raw = { ...summary, method: 'item/reasoning/textDelta', params: { ...summary.params, contentIndex: 0, delta: 'RAW_SENTINEL' } };
  for (const frames of [[raw, summary], [summary, raw]]) expect(thinking(await replay(frames))).toBe(summary.params.delta);
});
