import { DEFAULT_MODEL_OPTION, probeAdapterCommand } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const geminiAgentDef = {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    versionArgs: ['--version'],
    compatibilityProbe: (bin, env): Promise<void> => probeAdapterCommand(bin, geminiAgentDef.buildArgs('', []), env),
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      // Google Gemini API "All Gemini 3 models", retrieved 2026-09-04.
      // Gemini CLI accepts these endpoint ids through `--model`; it does not
      // expose an account-bound model-list command. Do not restore
      // gemini-3-pro-preview: Google's shutdown table marks it shut down.
      { id: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview' },
      { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash' },
      { id: 'gemini-3.7-flash', label: 'gemini-3.7-flash' },
      { id: 'gemini-3.6-flash', label: 'gemini-3.6-flash' },
      { id: 'gemini-3.5-flash', label: 'gemini-3.5-flash' },
      { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite' },
      { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite' },
      { id: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview' },
      { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
      // Cheapest 2.5 multimodal variant; useful for high-volume / low-latency work.
      { id: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite' },
    ],
    // Gemini reads from stdin when `-p` is omitted and stdin is a pipe.
    // Passing the full composed prompt as a CLI arg causes ENAMETOOLONG on
    // Windows (CreateProcess limit ~32 KB) for any non-trivial prompt.
    // `--yolo` skips interactive approval prompts in the no-TTY web UI.
    // Workspace trust is provided via `GEMINI_CLI_TRUST_WORKSPACE` below
    // instead of `--skip-trust`; several Gemini CLI builds hide or reject the
    // flag even though they accept the documented environment variable.
    env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    buildArgs: (_prompt: string, _imagePaths: string[], _extra?: string[], options: { model?: string | null } = {}): string[] => {
      const args = ['--output-format', 'stream-json', '--yolo'];
      if (options.model && options.model !== 'default') {
        args.push('--model', options.model);
      }
      return args;
    },
    promptViaStdin: true,
    streamFormat: 'json-event-stream',
    eventParser: 'gemini',
} satisfies RuntimeAgentDef;
