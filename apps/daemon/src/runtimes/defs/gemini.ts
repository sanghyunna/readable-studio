import { probeAdapterCommand } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const geminiAgentDef = {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    versionArgs: ['--version'],
    // Gemini 0.1.9 accepts --help but not --output-format. Inspect arguments
    // without starting an inference session or requiring authentication.
    compatibilityProbe: (bin, env): Promise<void> => probeAdapterCommand(bin, [...geminiAgentDef.buildArgs('', []), '--help'], env),
    // No account-bound listing command: omit listModels/fetchModels so shared
    // discovery reports unverified, rather than promoting static model hints.
    fallbackModels: [],
    // Gemini reads from stdin when `-p` is omitted and stdin is a pipe.
    // Passing the full composed prompt as a CLI arg causes ENAMETOOLONG on
    // Windows (CreateProcess limit ~32 KB) for any non-trivial prompt.
    // `--yolo` skips interactive approval prompts in the no-TTY web UI.
    // Workspace trust is provided via `GEMINI_CLI_TRUST_WORKSPACE` below
    // instead of `--skip-trust`; several Gemini CLI builds hide or reject the
    // flag even though they accept the documented environment variable.
    env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    buildArgs: (_prompt: string, _imagePaths: string[], _extra?: string[], options: { model?: string | null } = {}): string[] => {
      const args = ['--yolo'];
      if (options.model && options.model !== 'default') {
        args.push('--model', options.model);
      }
      return args;
    },
    promptViaStdin: true,
    streamFormat: 'plain',
} satisfies RuntimeAgentDef;
