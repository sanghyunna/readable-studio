import { agentCapabilities } from '../capabilities.js';
import { spawnEnvForAgent } from '../env.js';
import { execAgentFile } from '../invocation.js';
import { applyAgentLaunchEnv, resolveAgentLaunch } from '../launch.js';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import { discoverClaudeCatalog, parseClaudeModelCatalog } from './claude-model-discovery.js';
import { loadMmdRouteModels } from '../mmd-routes.js';
import type { RuntimeAgentDef } from '../types.js';

const CLAUDE_FALLBACK_MODELS = [DEFAULT_MODEL_OPTION];
const thinkingDisplayProbes = new Map<string, Promise<boolean>>();

// --version and --help ignore unknown options. An invalid display value must
// instead produce the CLI's recognized-option validation error before inference.
export async function probeClaudeThinkingDisplaySupport(bin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execAgentFile(bin, ['--thinking-display', '__readable_capability_probe__', '-p'], { env, timeout: 5000 });
    return false;
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? error.stderr : null;
    return typeof stderr === 'string' && stderr.includes("option '--thinking-display") && stderr.includes('argument') && stderr.includes('is invalid');
  }
}

export async function ensureClaudeThinkingDisplayCapability(configuredEnv: Record<string, string>): Promise<void> {
  const launch = resolveAgentLaunch(claudeAgentDef, configuredEnv);
  if (!launch.launchPath) return;
  const env = applyAgentLaunchEnv(spawnEnvForAgent('claude', process.env, configuredEnv, undefined, { resolvedBin: launch.selectedPath }), launch);
  let probe = thinkingDisplayProbes.get(launch.launchPath);
  if (!probe) {
    probe = probeClaudeThinkingDisplaySupport(launch.launchPath, env);
    thinkingDisplayProbes.set(launch.launchPath, probe);
  }
  const thinkingDisplay = await probe;
  agentCapabilities.set('claude', { ...agentCapabilities.get('claude'), thinkingDisplay });
}

export const claudeAgentDef = {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    // Drop-in forks that ship a CLI argv-compatible with `claude`. Tried in
    // order if `claude` itself isn't on PATH, so users on a single-binary
    // install (e.g. only OpenClaude — https://github.com/Gitlawb/openclaude
    // — issue #235) get auto-detected without writing wrapper scripts.
    fallbackBins: ['openclaude'],
    versionArgs: ['--version'],
    helpArgs: ['-p', '--help'],
    // Initialize reports selectors even without credentials; check sign-in separately.
    authProbe: { args: ['auth', 'status', '--json'], timeoutMs: 5000 },
    capabilityFlags: {
      // Flag string -> capability key. After probing `--help`, we set
      // `agentCapabilities[id][key] = true` for each substring that matches.
      // `--add-dir` and `--include-partial-messages` live under `claude -p`
      // subcommand, so we probe `claude -p --help` instead of `claude --help`.
      // Fixes issue #430: --add-dir never detected because it wasn't in global help.
      '--include-partial-messages': 'partialMessages',
      '--add-dir': 'addDir',
    },
    // MMS aliases override the CLI selector catalogue; static ids are never detected.
    fallbackModels: CLAUDE_FALLBACK_MODELS,
    // Claude Code 2.1.258 --help: --effort (not Pi's --thinking).
    reasoningOptions: [
      { id: 'default', label: 'Default' },
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'XHigh' },
      { id: 'max', label: 'Max' },
    ],
    fetchModels: async (resolvedBin, env, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const routes = await loadMmdRouteModels(env, []);
      return routes ?? parseClaudeModelCatalog(await discoverClaudeCatalog(resolvedBin, env, signal ? { signal } : {}));
    },
    // Prompt delivered via stdin to avoid both Linux `spawn E2BIG`
    // (MAX_ARG_STRLEN caps a single argv entry at ~128 KB) and Windows
    // `spawn ENAMETOOLONG` (CreateProcess caps the full command line at
    // ~32 KB direct, ~8 KB via .cmd shim). `claude -p` with no positional
    // prompt reads the prompt from stdin under `--input-format text` (the
    // default), which has no length cap. Mirrors the codex/gemini/opencode/
    // cursor/qwen entries below.
    buildArgs: (_prompt, _imagePaths, extraAllowedDirs = [], options = {}, runtimeContext = {}) => {
      const caps = agentCapabilities.get('claude') || {};
      // `--input-format stream-json` lets the daemon stream multiple JSONL
      // messages into stdin instead of closing it after the initial prompt,
      // keeping the turn open so the daemon can stream further user messages
      // mid-conversation. Paired with `--output-format stream-json` so the
      // adapter parses structured events (see claude-stream.ts).
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
      // `--include-partial-messages` lands richer streaming events but only
      // exists in newer Claude Code builds. Older installs reject it with
      // "unknown option" and exit 1, killing the chat. Gate on the probe.
      if (caps.partialMessages) {
        args.push('--include-partial-messages');
      }
      if (options.model && options.model !== 'default') {
        args.push('--model', options.model);
      }
      if (options.reasoning && options.reasoning !== 'default') {
        args.push('--effort', options.reasoning);
      }
      // Display does not change the model's selected/default reasoning effort.
      if (caps.thinkingDisplay) args.push('--thinking-display', 'summarized');
      const dirs = (extraAllowedDirs || []).filter(
        (d) => typeof d === 'string' && d.length > 0,
      );
      // `--add-dir` is older but still gate it for symmetry — old/forked
      // builds may lack it.
      if (dirs.length > 0 && caps.addDir !== false) {
        args.push('--add-dir', ...dirs);
      }
      // Continue Claude's own CLI session across turns so it keeps its
      // working memory (files read, edits made, tool history) instead of
      // re-deriving everything from the rendered transcript each turn.
      // `--resume <id>` continues a stored session; `--session-id <uuid>`
      // starts a new one with an id the daemon controls and persists.
      if (typeof runtimeContext.resumeSessionId === 'string' && runtimeContext.resumeSessionId) {
        args.push('--resume', runtimeContext.resumeSessionId);
      } else if (typeof runtimeContext.newSessionId === 'string' && runtimeContext.newSessionId) {
        args.push('--session-id', runtimeContext.newSessionId);
      }
      args.push('--permission-mode', 'bypassPermissions');
      return args;
    },
    promptViaStdin: true,
    promptInputFormat: 'stream-json',
    streamFormat: 'claude-stream-json',
    // Claude Code auto-loads `.mcp.json` from the project cwd at spawn,
    // so the daemon writes the user's external MCP servers there before
    // launching (server.ts handles the cwd guard).
    externalMcpInjection: 'claude-mcp-json',
    resumesSessionViaCli: true,
} satisfies RuntimeAgentDef;
