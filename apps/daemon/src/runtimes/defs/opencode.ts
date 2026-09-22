import { DEFAULT_MODEL_OPTION, parseLineSeparatedModels } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';
import { execAgentFile } from '../invocation.js';
import { stripVTControlCharacters } from 'node:util';

class OpenCodeDiscoveryError extends Error {
  constructor(readonly code: 'AUTH_MISSING' | 'AUTH_MALFORMED' | 'MODELS_MALFORMED') {
    super(code === 'AUTH_MISSING'
      ? 'Authentication required: OpenCode reports zero credentials.'
      : `OpenCode discovery output could not be parsed (${code}).`);
  }
}

export function parseOpenCodeModels(stdout: string) {
  const text = String(stdout || '');
  // A successful process exit is not proof of a model table. Do not turn
  // sign-in guidance or documentation URLs into selectable provider/model ids.
  if (/authentication required|not authenticated|not logged in|please (?:log|sign) in/i.test(text)) {
    return null;
  }
  const rows = text.split('\n').map((line) => line.trim()).filter((line) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(line),
  );
  return rows.length > 0 ? parseLineSeparatedModels(rows.join('\n')) : null;
}

export const opencodeAgentDef = {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode-cli',
    fallbackBins: ['opencode'],
    versionArgs: ['--version'],
    // auth list reports configured credentials, not merely the public catalogue.
    authProbe: { args: ['auth', 'list'], timeoutMs: 15_000 },
    compatibilityProbe: async (resolvedBin, env) => {
      const { stdout, stderr } = await execAgentFile(resolvedBin, ['auth', 'list'], {
        env, timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      const text = stripVTControlCharacters(`${stdout}\n${stderr}`);
      const count = text.match(/(?:^|\n)\s*└\s+(\d+) credentials?\s*(?:\n|$)/)?.[1];
      if (count === undefined) throw new OpenCodeDiscoveryError('AUTH_MALFORMED');
      if (Number(count) === 0) throw new OpenCodeDiscoveryError('AUTH_MISSING');
    },
    // `opencode models` prints `provider/model` per line. Real-world
    // `opencode models` calls can take >8s (network round-trip to the
    // provider registry), so the previous 8s budget timed out and fell back
    // to the hardcoded `fallbackModels`, hiding the user's actual catalog.
    // 15s matches the listModels budget the rest of the agent defs use
    // (devin, hermes, kiro, kilo, kimi, trae-cli, vibe, reasonix).
    listModels: {
      args: ['models'],
      parse: (stdout) => {
        const models = parseOpenCodeModels(stdout);
        if (!models) throw new OpenCodeDiscoveryError('MODELS_MALFORMED');
        return models;
      },
      timeoutMs: 15_000,
    },
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      {
        id: 'anthropic/claude-sonnet-4-5',
        label: 'anthropic/claude-sonnet-4-5',
      },
      { id: 'openai/gpt-5', label: 'openai/gpt-5' },
      { id: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
    ],
    // OpenCode 1.17.8 run --help exposes --variant for provider-specific
    // effort. --thinking only shows thinking blocks; it does not set effort.
    // These are built-in variant names, not a promise that every model has
    // every variant (provider/model configuration owns that vocabulary).
    reasoningOptions: [
      { id: 'default', label: 'Default' },
      { id: 'none', label: 'None' },
      { id: 'minimal', label: 'Minimal' },
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'XHigh' },
      { id: 'max', label: 'Max' },
    ],
    // Prompt delivered via stdin (`opencode run` with no message argv) to
    // avoid Windows `spawn ENAMETOOLONG` while preserving OpenCode's
    // structured stream. A literal `-` is parsed as a positional message by
    // OpenCode 1.14.x and can surface as "Session not found".
    buildArgs: (_prompt, _imagePaths, _extra, options = {}) => {
      const args = [
        'run',
        '--format',
        'json',
      ];
      if (options.model && options.model !== 'default') {
        args.push('-m', options.model);
      }
      if (options.reasoning && options.reasoning !== 'default') {
        args.push('--variant', options.reasoning);
      }
      return args;
    },
    promptViaStdin: true,
    streamFormat: 'json-event-stream',
    eventParser: 'opencode',
    // OpenCode reads MCP servers from its layered config (global ~/.config
    // /opencode/opencode.json + project opencode.json + OPENCODE_CONFIG
    // + OPENCODE_CONFIG_CONTENT). The env-var form lets the daemon hand
    // user-configured external MCP servers to a single `opencode run`
    // invocation without polluting the user's saved config files. See
    // <https://opencode.ai/docs/config> and issue #2142.
    externalMcpInjection: 'opencode-env-content',
} satisfies RuntimeAgentDef;
