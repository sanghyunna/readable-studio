import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { withDeadline } from '../../src/databricks/client.js';
import { startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { runtimeFixture, runtimeServiceFixture } from './runtime-fixture.js';

function stream(command?: { readonly name: string; readonly command: string }) {
  const frames = [
    { type: 'message_start', message: { id: 'msg_shell', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: command
      ? { type: 'tool_use', id: 'toolu_shell', name: command.name, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: command
      ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: command.command, timeout: 10 }) }
      : { type: 'text_delta', text: 'SHELL_COMPLETE' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: command ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

for (const failure of [false, true]) {
  test(`managed Pi executes PowerShell ${failure ? 'failure' : 'success'} when Git Bash is unresolvable`, async () => {
    // Given: the actual embedded Pi process has no PATH or Git location variables.
    const root = await mkdtemp(path.join(tmpdir(), 'pi-native-shell-'));
    const runtime = runtimeFixture('anthropic-messages');
    const { service } = runtimeServiceFixture(runtime);
    let calls = 0;
    let toolNames: string[] = [];
    const results: Array<{ readonly is_error?: boolean; readonly content: unknown }> = [];
    const events: Record<string, unknown>[] = [];
    try {
      const run = await startDatabricksPiSession({
        dataRoot: root, cwd: root, sessionKey: 'native-shell', model: runtime.appModelId, service,
        env: { PATH: '', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
        prompt: 'Execute the shell operation.', send: (_channel, event) => events.push(event),
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          calls++;
          if (calls === 1) {
            toolNames = body.tools.map((tool: { name: string }) => tool.name);
            const name = toolNames.includes('powershell') ? 'powershell' : 'bash';
            return stream({ name, command: failure ? "[Console]::Write('PS_FAILURE_73'); exit 7"
              : "[Console]::Write(('PS_NATIVE_' + $PSVersionTable.PSEdition + '_' + (6 * 7)))" });
          }
          for (const message of body.messages) {
            if (!Array.isArray(message.content)) continue;
            results.push(...message.content.filter((block: { type: string }) => block.type === 'tool_result'));
          }
          return stream();
        },
      });
      try {
        // When: a wire-level model tool call executes in the real Pi child.
        await withDeadline(() => run.completed, 25_000);
        // Then: the tool returns native PowerShell output, including failures, to the model.
        expect(run.session.hasFatalError()).toBe(false);
        expect(calls).toBe(2);
        expect(results).toHaveLength(1);
        const result = results[0];
        assert.ok(result);
        expect(JSON.stringify(result.content)).toContain(failure ? 'PS_FAILURE_73' : 'PS_NATIVE_Desktop_42');
        expect(result.is_error ?? false).toBe(failure);
        expect(toolNames.sort()).toEqual(['edit', 'powershell', 'read', 'write']);
        expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe('SHELL_COMPLETE');
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
        await withDeadline(() => Promise.allSettled([run.completed]), 5_000);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 35_000);
}
