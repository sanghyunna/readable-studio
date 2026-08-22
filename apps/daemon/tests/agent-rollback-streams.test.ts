import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeHttpServer } from '../src/daemon-startup.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';

describe('agent rollback stream filtering', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => closeHttpServer(server));

  it.each([
    {
      agentId: 'claude',
      bin: 'claude',
      script: `
if (process.argv.includes('--version')) { console.log('claude 1.0.0'); process.exit(0); }
if (process.argv.includes('--help')) { process.exit(0); }
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' } } }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before <readable-rollback-request mode="files_only" /> after <' } } }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
console.log(JSON.stringify({ type: 'result', usage: {}, stop_reason: 'end_turn' }));
`,
    },
    {
      agentId: 'qwen',
      bin: 'qwen',
      script: `
if (process.argv.includes('--version')) { console.log('qwen 1.0.0'); process.exit(0); }
process.stdout.write('before <readable-rollback-request mode="files_only" /> after <');
`,
    },
  ])('leaves rollback markers inert for legacy $agentId streams', async ({ agentId, bin, script }) => {
    await withFakeAgent(bin, script, async () => {
      const response = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, message: 'test' }),
      });
      expect(response.status).toBe(202);
      const { runId } = await response.json() as { runId: string };
      await waitForRun(baseUrl, runId);

      const events = await fetch(`${baseUrl}/api/runs/${runId}/events`);
      const body = await events.text();
      expect(body).toContain('before ');
      expect(body).toContain(' after ');
      expect(body).toContain('readable-rollback-request');
      expect(body).not.toContain('"type":"rollback_request"');
    });
  });

  it('does not accept rollback requests from a non-isolated Critique Theater run', async () => {
    const projectId = `critique-rollback-${randomUUID()}`;
    const createProject = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Critique rollback stream' }),
    });
    expect(createProject.status).toBe(200);
    const { conversationId } = await createProject.json() as { conversationId: string };
    const originalCritiqueEnabled = process.env.READABLE_CRITIQUE_ENABLED;
    process.env.READABLE_CRITIQUE_ENABLED = 'true';

    try {
      await withFakeAgent('qwen', `
  process.stdout.write('<CRITIQUE_RUN version="1" maxRounds="1" threshold="8.0" scale="10">\\n');
  process.stdout.write('<readable-rollback-request mode="files_only" reason="critique made the wrong edit" />\\n');
  process.stdout.write('<ROUND n="1">\\n');
  process.stdout.write('<PANELIST role="designer"><NOTES>v1</NOTES><ARTIFACT mime="text/html"><![CDATA[<p>v1</p>]]></ARTIFACT></PANELIST>\\n');
  process.stdout.write('<PANELIST role="critic" score="9"><DIM name="h" score="9">ok</DIM></PANELIST>\\n');
  process.stdout.write('<PANELIST role="brand" score="9"><DIM name="v" score="9">ok</DIM></PANELIST>\\n');
  process.stdout.write('<PANELIST role="a11y" score="9"><DIM name="c" score="9">ok</DIM></PANELIST>\\n');
  process.stdout.write('<PANELIST role="copy" score="9"><DIM name="cl" score="9">ok</DIM></PANELIST>\\n');
  process.stdout.write('<ROUND_END n="1" composite="9" must_fix="0" decision="ship"><REASON>ok</REASON></ROUND_END>\\n');
  process.stdout.write('</ROUND>\\n');
  process.stdout.write('<SHIP round="1" composite="9" status="shipped"><ARTIFACT mime="text/html"><![CDATA[<p>final</p>]]></ARTIFACT><SUMMARY>done</SUMMARY></SHIP>\\n');
  process.stdout.write('</CRITIQUE_RUN>\\n');
`, async () => {
        const response = await fetch(`${baseUrl}/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'qwen',
            projectId,
            conversationId,
            designSystemId: 'default',
            skillId: 'faq-page',
            message: 'test critique rollback',
          }),
        });
        expect(response.status).toBe(202);
        const { runId } = await response.json() as { runId: string };
        await waitForRun(baseUrl, runId);

        const events = await fetch(`${baseUrl}/api/runs/${runId}/events`);
        const body = await events.text();
        expect(body).not.toContain('"type":"rollback_request"');
        expect(body).toContain('event: critique.degraded');
      });
    } finally {
      if (originalCritiqueEnabled == null) delete process.env.READABLE_CRITIQUE_ENABLED;
      else process.env.READABLE_CRITIQUE_ENABLED = originalCritiqueEnabled;
    }
  });
});

async function waitForRun(baseUrl: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const body = await response.json() as { status: string };
    if (body.status !== 'queued' && body.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not finish`);
}
