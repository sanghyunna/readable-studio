import path from 'node:path';
import { DEFAULT_MODEL_OPTION, execAgentFile, parsePiModels } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const piAgentDef = {
    id: 'pi',
    name: 'Pi',
    bin: 'pi',
    versionArgs: ['--version'],
    // `pi --list-models` writes its model table to stdout.
    fetchModels: async (resolvedBin, env) => {
      const { stdout } = await execAgentFile(resolvedBin, ['--list-models'], {
        env,
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      // Pi lists only credential-available models. Its no-auth guidance is
      // prose, not a table; never turn words or documentation paths into IDs.
      if (String(stdout).startsWith('No models available.')) return [DEFAULT_MODEL_OPTION];
      return parsePiModels(stdout);
    },
    // A failed or empty listing cannot establish authenticated model usability.
    // Let discovery failures propagate to the shared diagnostic classifier.
    fallbackModels: [],
    // Thinking level presets mapped to pi's --thinking flag.
    reasoningOptions: [
      { id: 'default', label: 'Default' },
      { id: 'off', label: 'Off' },
      { id: 'minimal', label: 'Minimal' },
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'XHigh' },
      { id: 'max', label: 'Max' },
    ],
    // pi's RPC mode drives the entire conversation over stdio JSON-RPC.
    // The daemon sends a `prompt` command and pi streams back typed events.
    // No prompt in argv — avoids ENAMETOOLONG and keeps the protocol clean.
    buildArgs: (
      _prompt,
      _imagePaths,
      extraAllowedDirs = [],
      options = {},
      runtimeContext = {},
    ) => {
      const args = ['--mode', 'rpc'];
      if (options.model && options.model !== 'default') {
        // pi --model accepts patterns ("sonnet", "anthropic/claude-sonnet-4-5",
        // "openai/gpt-5:high") so we pass the value through as-is.
        args.push('--model', options.model);
      }
      if (options.reasoning && options.reasoning !== 'default') {
        args.push('--thinking', options.reasoning);
      }
      // pi supports --append-system-prompt for cwd and extra context.
      // For now we rely on the composed prompt containing the cwd hint
      // (same pattern as other agents) rather than using system-prompt flags.
      //
      // extraAllowedDirs carries skill seed and design-system directories
      // that live outside the project cwd. pi doesn't have an --add-dir
      // sandbox flag (it uses OS cwd), so we use --append-system-prompt to
      // hint that these directories exist. The agent can then use its Read
      // tool to access files inside them. Without this, pi runs inside the
      // project cwd and has no way to discover or reach skill/design-system
      // assets that live elsewhere.
      const dirs = (extraAllowedDirs || []).filter(
        (d) => typeof d === 'string' && path.isAbsolute(d),
      );
      for (const d of dirs) {
        args.push('--append-system-prompt', d);
      }
      return args;
    },
    // Prompt is sent via RPC `prompt` command on stdin, not as a CLI arg.
    promptViaStdin: true,
    streamFormat: 'pi-rpc',
    // pi's RPC `prompt` command supports an `images` field for multimodal
    // input (base64-encoded). The daemon attaches image paths to the
    // session so attachPiRpcSession can read and forward them.
    supportsImagePaths: true,
} satisfies RuntimeAgentDef;
