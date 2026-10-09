import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { attachCodexAppServerSession } from '../src/runtimes/codex-app-server.js';
import { expectedDocumentArtifact } from '../src/document-completion.js';
import { finalGenReportEvents } from './helpers/final-gen-report-events.js';

async function runPeer(mode: 'recover' | 'missing' | 'question', report?: keyof typeof finalGenReportEvents) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'codex-artifact-'));
  const expectedArtifactPath = expectedDocumentArtifact({ cwd, metadata: { kind: 'report' }, sessionMode: 'design', pluginAuthoring: false })!;
  const deltas = report ? finalGenReportEvents[report].flatMap(event => 'type' in event && event.type === 'text_delta' ? [event.delta] : []) : [];
  const fixture = `
const {createInterface}=require('node:readline');
const {writeFileSync}=require('node:fs');
let turns=0;
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start'){
  turns++;
  send({id:m.id,result:{turn:{id:'turn-'+turns}}});
  send({method:'turn/started',params:{turn:{id:'turn-'+turns}}});
  if(turns===2 && ${JSON.stringify(mode)}==='recover')writeFileSync(${JSON.stringify(expectedArtifactPath)},'<!doctype html><html>real output</html>');
  const text=${JSON.stringify(mode)}==='question'?'<question-form id="brief">{"questions":[{"id":"topic","question":"Topic?","options":[{"label":"A","value":"a"},{"label":"B","value":"b"}]}]}</question-form>':'index.html written';
  if(turns===1 && ${JSON.stringify(!!report)}) {
    for(const delta of ${JSON.stringify(deltas)}) send({method:'item/agentMessage/delta',params:{itemId:'message-'+turns,delta}});
  } else send({method:'item/completed',params:{item:{id:'message-'+turns,type:'agentMessage',text}}});
  send({method:'turn/completed',params:{turn:{status:'completed'}}});
 }
}).on('close',()=>process.exit(0));`;
  const child = spawn(process.execPath, ['-e', fixture], { cwd, stdio: 'pipe', windowsHide: true });
  const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
  const events: Record<string, unknown>[] = [];
  const options = { child, prompt: 'Create index.html', cwd, model: 'selected-model', expectedArtifactPath, onEvent: (event: Record<string, unknown>) => events.push(event) };
  const session = attachCodexAppServerSession(options);
  try {
    await closed;
    expect(events.filter(event => event.type === 'status' && event.label === 'running')).toHaveLength(mode === 'question' ? 1 : 2);
    // The bounded close signal proves recovery cannot leave its peer running.
    expect(() => process.kill(child.pid!, 0)).toThrow();
    return { success: session.completedSuccessfully(), fatal: session.hasFatalError(), exists: existsSync(expectedArtifactPath), events };
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const report of ['report-1', 'report-2'] as const) {
  it(`recovers the exact ${report} receipt/plain-question sequence`, async () => {
    const result = await runPeer('recover', report);
    expect(result.exists).toBe(true);
    expect(result.success).toBe(true);
  });
  it(`fails after one corrective turn for the exact ${report} sequence`, async () => {
    const result = await runPeer('missing', report);
    expect(result.success).toBe(false);
    expect(result.fatal).toBe(true);
  });
}

it('continues a completed generation that claims a missing entry was written', async () => {
  const result = await runPeer('recover');
  expect(result.exists).toBe(true);
  expect(result.success).toBe(true);
  expect(result.fatal).toBe(false);
});

it('fails honestly if the corrective turn still produces no entry', async () => {
  const result = await runPeer('missing');
  expect(result.success).toBe(false);
  expect(result.fatal).toBe(true);
  expect(result.events.some(event => event.type === 'error')).toBe(true);
});

it('allows a legitimate clarification without requiring an entry', async () => {
  const result = await runPeer('question');
  expect(result.success).toBe(true);
  expect(result.exists).toBe(false);
});

it('tags only the missing-document failure with the dedicated error code', async () => {
  const missing = await runPeer('missing');
  expect(missing.events.filter(event => event.type === 'error')).toEqual([
    expect.objectContaining({ code: 'DOCUMENT_NOT_SAVED', message: 'Document generation completed without saving index.html in the project root.' }),
  ]);
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: 'pipe', windowsHide: true });
  const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
  const events: Record<string, unknown>[] = [];
  attachCodexAppServerSession({ child, prompt: 'x', cwd: tmpdir(), model: 'default', onEvent: event => events.push(event) });
  await closed;
  expect(events).toEqual([{ type: 'error', message: 'An explicit Codex model is required' }]);
});
