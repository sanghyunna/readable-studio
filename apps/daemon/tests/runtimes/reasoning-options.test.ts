import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AGENT_DEFS, getAgentDef } from '../../src/runtimes/registry.js';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

function agent(id: string): RuntimeAgentDef {
  const def = getAgentDef(id);
  assert.ok(def, `Missing runtime ${id}`);
  return def;
}

const supported = [
  { id: 'pi', flag: '--thinking', model: 'anthropic/claude-opus-4-5', levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude', flag: '--effort', model: 'opus', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'codex', flag: '-c', model: 'gpt-5', levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'copilot', flag: '--reasoning-effort', model: 'claude-sonnet-4.6', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'qoder', flag: '--reasoning-effort', model: 'performance', levels: ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'aider', flag: '--reasoning-effort', model: 'o3-mini', levels: ['low', 'medium', 'high'] },
  { id: 'opencode', flag: '--variant', model: 'openai/gpt-5', levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'grok-build', flag: '--effort', model: 'grok-4.20-reasoning', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'reasonix', flag: '--effort', model: 'deepseek-v4-pro', levels: ['low', 'medium', 'high', 'max'] },
  { id: 'deepseek', flag: '--reasoning-effort', model: 'deepseek-v4-pro', levels: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
];

for (const { id, flag, model, levels } of supported) {
  test(`${id} advertises its native effort vocabulary`, () => {
    assert.deepEqual(agent(id).reasoningOptions?.map((option) => option.id), ['default', ...levels]);
  });

  for (const level of levels) {
    test(`${id} maps ${level} to the exact launch option`, () => {
      const def = agent(id);
      const context = { promptFilePath: 'C:/runtime/prompt.md' };
      const base = def.buildArgs('prompt', [], [], { model }, context);
      const args = def.buildArgs('prompt', [], [], { model, reasoning: level }, context);
      const value = id === 'codex' ? `model_reasoning_effort="${level}"` : level;
      const at = args.indexOf(value);
      assert.ok(at > 0);
      assert.equal(args[at - 1], flag);
      // Removing exactly the selected flag/value must recover the entire base
      // invocation, including stdin/ACP mode, model, and positional prompt.
      assert.deepEqual([...args.slice(0, at - 1), ...args.slice(at + 1)], base);
    });
  }

  test(`${id} leaves CLI configuration alone when effort is default or absent`, () => {
    const def = agent(id);
    const context = { promptFilePath: 'C:/runtime/prompt.md' };
    const base = def.buildArgs('prompt', [], [], { model }, context);
    for (const reasoning of ['default', '', null]) {
      assert.deepEqual(def.buildArgs('prompt', [], [], { model, reasoning }, context), base);
    }
  });
}

// No selectable per-run effort transport in these adapters. This assertion is
// deliberately independent of thinking events or model names: neither implies
// that an arbitrary --thinking/--effort flag is supported by the invoked CLI.
const withoutEffort = [
  'amr', 'antigravity', 'cursor-agent', 'devin', 'gemini', 'hermes',
  'kilo', 'kimi', 'kiro', 'qwen', 'trae-cli', 'vibe',
];

for (const id of withoutEffort) {
  test(`${id} advertises no effort and never receives a reasoning launch flag`, () => {
    const def = agent(id);
    assert.deepEqual(def.reasoningOptions ?? [], []);
    const base = def.buildArgs('prompt', [], [], {});
    for (const reasoning of ['default', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      assert.deepEqual(def.buildArgs('prompt', [], [], { reasoning }), base);
    }
  });
}

test('every built-in runtime has an audited reasoning classification', () => {
  // Local user profiles are inherited definitions rather than files in defs/.
  const classified = [...supported.map((entry) => entry.id), ...withoutEffort, 'databricks'];
  assert.equal(new Set(classified).size, 23);
  for (const id of classified) assert.ok(AGENT_DEFS.some((def) => def.id === id));
});

test('Claude effort keeps the exact non-interactive stream-json launch contract', () => {
  assert.deepEqual(agent('claude').buildArgs('', [], [], { model: 'opus', reasoning: 'xhigh' }), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', 'opus', '--effort', 'xhigh', '--permission-mode', 'bypassPermissions',
  ]);
});

test('Grok never sends effort for default or non-reasoning models', () => {
  const def = agent('grok-build');
  for (const model of ['default', 'grok-build', 'grok-4.20-non-reasoning']) {
    const args = def.buildArgs('', [], [], { model, reasoning: 'high' }, { promptFilePath: 'C:/runtime/prompt.md' });
    assert.equal(args.includes('--effort'), false);
  }
});

test('Databricks does not flatten per-model reasoning into an agent-wide list', () => {
  assert.deepEqual(agent('databricks').reasoningOptions, []);
});
