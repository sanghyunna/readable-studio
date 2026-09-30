import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeStreamHandler } from '../../src/claude-stream.js';
import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import { attachCodexAppServerSession } from '../../src/runtimes/codex-app-server.js';
import { claudeAgentDef, ensureClaudeThinkingDisplayCapability } from '../../src/runtimes/defs/claude.js';
import { codexAgentDef } from '../../src/runtimes/defs/codex.js';
import { writeExecutableScript } from '../helpers/fake-agent.js';

const fixtureUrl = new URL('../../../../mocks/fixtures/thinking-claude-codex/', import.meta.url);

describe('captured CLI thinking streams', () => {
  it('does not invent Claude thinking when the actual high-effort CLI stream contains only empty thinking deltas', () => {
    // Given: Claude Code 2.1.283, Opus/high, --include-partial-messages.
    const events: Record<string, unknown>[] = [];
    const parser = createClaudeStreamHandler(event => events.push(event));
    // When: the captured stream is replayed without synthesizing provider content.
    parser.feed(readFileSync(new URL('claude-stream.jsonl', fixtureUrl), 'utf8'));
    parser.flush();
    // Then: the assistant answer arrives, but no plaintext thinking was supplied.
    expect(events.filter(event => event.type === 'thinking_delta' && event.delta)).toHaveLength(0);
    expect(events.some(event => event.type === 'text_delta')).toBe(true);
  });

  it('forwards actual Opus/high summarized thinking once, without repeating the assistant wrapper', () => {
    // Given: Claude Code 2.1.283 with --thinking-display summarized.
    const frames = readFileSync(new URL('claude-variant-opus-display.jsonl', fixtureUrl), 'utf8');
    const actualThinking = frames.trim().split('\n').map(line => JSON.parse(line))
      .filter(frame => frame.type === 'stream_event' && frame.event?.delta?.type === 'thinking_delta')
      .map(frame => frame.event.delta.thinking).join('');
    expect(actualThinking.length).toBeGreaterThan(0);
    const events: Record<string, unknown>[] = [];
    const parser = createClaudeStreamHandler(event => events.push(event));
    // When: the captured CLI output is replayed through the production parser.
    parser.feed(frames);
    parser.flush();
    // Then: the same thinking appears once on the shared event channel.
    expect(events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join(''))
      .toBe(actualThinking);
  });

  it.each([
    { support: 'supported', stderr: "error: option '--thinking-display <display>' argument '__readable_capability_probe__' is invalid. Allowed choices are summarized, omitted, highlights.", display: true },
    { support: 'unsupported', stderr: "error: unknown option '--thinking-display'", display: false },
    { support: 'unknown', stderr: 'unexpected CLI failure', display: false },
  ])('uses Claude summaries at default and high effort only when the CLI is $support', async ({ stderr, display }) => {
    // Given: a side-effect-free CLI option-parser response from an installed executable.
    const dir = await mkdtemp(join(tmpdir(), 'readable-claude-probe-'));
    const previous = agentCapabilities.get('claude');
    try {
      const bin = await writeExecutableScript(dir, 'claude', `process.stderr.write(${JSON.stringify(stderr)});process.exit(1);`);
      // When: run preparation probes and caches the binary's capability.
      await ensureClaudeThinkingDisplayCapability({ CLAUDE_BIN: bin });
      const defaultArgs = claudeAgentDef.buildArgs('', [], [], { model: 'opus', reasoning: 'default' });
      const high = claudeAgentDef.buildArgs('', [], [], { model: 'opus', reasoning: 'high' });
      // Then: even default effort displays summaries when supported; high keeps its effort.
      expect(defaultArgs.includes('--thinking-display')).toBe(display);
      expect(high.includes('--thinking-display')).toBe(display);
      expect(high).toContain('--effort');
      if (display) expect(defaultArgs.slice(defaultArgs.indexOf('--thinking-display'), defaultArgs.indexOf('--thinking-display') + 2))
        .toEqual(['--thinking-display', 'summarized']);
    } finally {
      if (previous) agentCapabilities.set('claude', previous);
      else agentCapabilities.delete('claude');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requests a reasoning summary without changing selected Codex effort', () => {
    // Given: a selected reasoning level on a reasoning-capable model.
    // When: the daemon builds the real app-server invocation.
    const args = codexAgentDef.buildArgs('', [], [], { model: 'gpt-5.5', reasoning: 'high' });
    // Then: the CLI can emit summaryTextDelta rather than withholding summaries.
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('model_reasoning_summary="auto"');
  });

  it('does not request a summary when Codex reasoning is explicitly none', () => {
    // Given: a user who selected no reasoning.
    // When: the daemon builds the invocation.
    const args = codexAgentDef.buildArgs('', [], [], { model: 'gpt-5.5', reasoning: 'none' });
    // Then: no summary option changes that choice.
    expect(args).not.toContain('model_reasoning_summary="auto"');
  });

  it('forwards a captured Codex summary as the same thinking_delta event as ACP', async () => {
    // Given: actual Codex 0.155.1 app-server notifications recorded with summary=auto/detailed.
    const captured = readFileSync(new URL('codex-app-server.jsonl', fixtureUrl), 'utf8').trim().split('\n');
    const reasoning = captured.map(line => JSON.parse(line)).filter(event => event.method === 'item/reasoning/summaryTextDelta');
    expect(reasoning.length).toBeGreaterThan(0);
    const peer = `
      const {createInterface}=require('node:readline');
      const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      const replay=${JSON.stringify(captured)};
      createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='initialize') send({id:m.id,result:{}});
        if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
        if(m.method==='turn/start') {
          send({id:m.id,result:{turn:{id:'turn'}}});
          for(const frame of replay) send(JSON.parse(frame));
        }
      }).on('close',()=>process.exit(0));
    `;
    const child = spawn(process.execPath, ['-e', peer], { stdio: 'pipe', windowsHide: true });
    const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
    const events: Record<string, unknown>[] = [];
    // When: a real stdio peer replays the recorded frames through the app-server adapter.
    const session = attachCodexAppServerSession({ child, prompt: 'test', cwd: process.cwd(), model: 'gpt-5.5', onEvent: event => events.push(event) });
    try { await closed; } finally { if (child.exitCode === null) child.kill(); }
    // Then: the summary reaches the daemon's shared thinking channel.
    expect(session.completedSuccessfully()).toBe(true);
    expect(events.filter(event => event.type === 'thinking_delta').map(event => event.delta))
      .toEqual(reasoning.map(event => event.params.delta));
  });
});
