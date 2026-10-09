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
test('identical text in distinct items is retained, and chunks within one part are not separated', async () => {
  const delta = (itemId: string, delta: string) => ({ method: 'item/reasoning/summaryTextDelta', params: { itemId, summaryIndex: 0, delta } });
  expect(thinking(await replay([delta('one', 'same'), delta('one', 'same'), delta('two', 'samesame')]))).toBe('samesame\n\nsamesame');
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
