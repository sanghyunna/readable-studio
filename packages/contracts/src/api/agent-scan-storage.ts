import { z } from 'zod';

const model = z.object({ id: z.string().min(1), label: z.string(),
  reasoningOptions: z.array(z.object({ id: z.string(), label: z.string() })).optional() })
  .transform(({ reasoningOptions, ...rest }) => ({ ...rest, ...(reasoningOptions ? { reasoningOptions } : {}) }));
const fix = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('openDocs') }), z.object({ kind: z.literal('openInstall') }),
  z.object({ kind: z.literal('rescan') }),
  z.object({ kind: z.literal('setEnv'), envKey: z.string() }),
  z.object({ kind: z.literal('clearEnv'), envKey: z.string() }),
  z.object({ kind: z.literal('launchOAuth'), agentId: z.string() }),
]);
export const storedAgentScanSchema = z.object({
  version: z.literal(1),
  completedAt: z.string().datetime(),
  agentIds: z.array(z.string()),
  fingerprint: z.string(),
  results: z.array(z.object({
    id: z.string(), available: z.boolean(), models: z.array(model),
    modelsSource: z.enum(['live', 'fallback']),
    path: z.string().optional(), version: z.string().nullable().optional(),
    authStatus: z.enum(['ok', 'missing', 'unknown']).optional(), authMessage: z.string().optional(),
    diagnostics: z.array(z.object({
      reason: z.enum(['not-on-path', 'not-executable', 'shim-broken', 'configured-bin-invalid', 'auth-missing', 'auth-unknown']),
      severity: z.enum(['error', 'warning', 'info']), message: z.string(),
      detail: z.string().optional(), searchedDirs: z.array(z.string()).optional(),
      fixActions: z.array(fix).optional(),
    }).transform(({ detail, searchedDirs, fixActions, ...rest }) => ({
      ...rest, ...(detail !== undefined ? { detail } : {}),
      ...(searchedDirs ? { searchedDirs } : {}), ...(fixActions ? { fixActions } : {}),
    }))).optional(),
  }).transform(({ path, version, authStatus, authMessage, diagnostics, ...rest }) => ({
    ...rest, ...(path !== undefined ? { path } : {}), ...(version !== undefined ? { version } : {}),
    ...(authStatus !== undefined ? { authStatus } : {}), ...(authMessage !== undefined ? { authMessage } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  }))),
});
export type StoredAgentScan = z.infer<typeof storedAgentScanSchema>;
