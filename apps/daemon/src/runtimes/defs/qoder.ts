import path from 'node:path';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

const QODER_FALLBACK_MODEL_IDS = new Set([
  'lite',
  'efficient',
  'auto',
  'performance',
  'ultimate',
]);

export function parseQoderModels(stdout: string): RuntimeModelOption[] | null {
  const text = String(stdout || '').trim();
  if (!text || /not logged in/i.test(text)) return null;

  const candidates: Array<{ id: string; label: string }> = [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? (parsed as { models?: unknown }).models
        : null;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (typeof row === 'string') candidates.push({ id: row, label: row });
        else if (row && typeof row === 'object') {
          const item = row as Record<string, unknown>;
          const id = [item.id, item.modelId, item.model_id, item.name]
            .find((value): value is string => typeof value === 'string');
          if (id) {
            const label = [item.label, item.displayName, item.display_name, item.name]
              .find((value): value is string => typeof value === 'string') ?? id;
            candidates.push({ id, label });
          }
        }
      }
    }
  } catch {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^[-*]\s+/, '');
      if (!line || /^(available\s+)?models?:?$/i.test(line)) continue;
      const columns = line.split(/\s{2,}|\t+/).map((part) => part.trim()).filter(Boolean);
      const first = columns[0];
      if (!first) continue;
      const normalizedTier = first.toLowerCase();
      if (QODER_FALLBACK_MODEL_IDS.has(normalizedTier)) {
        candidates.push({ id: normalizedTier, label: columns[1] ?? first });
      } else if (/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(first)) {
        candidates.push({ id: first, label: columns[1] ?? first });
      }
    }
  }

  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set([DEFAULT_MODEL_OPTION.id]);
  for (const candidate of candidates) {
    const id = candidate.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: candidate.label.trim() || id });
  }
  return out.length > 1 ? out : null;
}

export const qoderAgentDef = {
    id: 'qoder',
    name: 'Qoder CLI',
    bin: 'qodercli',
    versionArgs: ['--version'],
    // Qoder CLI v1.1.42 exposes an account-bound `--list-models` option.
    // It exits non-zero with "Not logged in" before authentication, so the
    // detector automatically retains the dated fallback below in that case.
    listModels: {
      args: ['--list-models'],
      timeoutMs: 15_000,
      parse: parseQoderModels,
    },
    fallbackModels: [
      DEFAULT_MODEL_OPTION,
      { id: 'lite', label: 'Lite' },
      { id: 'efficient', label: 'Efficient' },
      { id: 'auto', label: 'Auto' },
      { id: 'performance', label: 'Performance' },
      { id: 'ultimate', label: 'Ultimate' },
    ],
    // Qoder print mode exits after the turn. Deliver the composed prompt via
    // stdin to avoid argv length limits, while using stream-json so the daemon
    // can surface text and usage incrementally. `--yolo` is Qoder's documented
    // non-interactive approval flag, and `-w` selects the workspace.
    // Authentication remains Qoder CLI-owned: users can rely on persisted
    // `qodercli login` state, or launch the daemon with
    // QODER_PERSONAL_ACCESS_TOKEN for automation. Do not add that token to
    // static adapter env; unlike Gemini's workspace trust flag it is a user
    // secret and already flows through the inherited process environment.
    buildArgs: (
      _prompt,
      imagePaths,
      extraAllowedDirs = [],
      options = {},
      runtimeContext = {},
    ) => {
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--yolo',
      ];
      if (runtimeContext.cwd) {
        args.push('-w', runtimeContext.cwd);
      }
      if (options.model && options.model !== 'default') {
        args.push('--model', options.model);
      }
      const dirs = (extraAllowedDirs || []).filter(
        (d) => typeof d === 'string' && path.isAbsolute(d),
      );
      const attachments = (imagePaths || []).filter(
        (p) => typeof p === 'string' && path.isAbsolute(p),
      );
      for (const d of dirs) args.push('--add-dir', d);
      for (const p of attachments) args.push('--attachment', p);
      return args;
    },
    promptViaStdin: true,
    streamFormat: 'qoder-stream-json',
} satisfies RuntimeAgentDef;
