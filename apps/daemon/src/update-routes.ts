import type { Express } from 'express';
import { compareUpdateVersions, type AutoUpdateConfig, type UpdateCheckResult } from '@readable-studio/contracts';
import { readCurrentAppVersionInfo } from './app-version.js';
import { DatabricksUpdateSource, UpdateSourceError, type UpdateTokenProvider } from './update-source.js';
import { readAppConfig } from './app-config.js';
import { resolve } from 'node:path';
import { updateDownload } from './update-download.js';

export interface UpdateCheckDependencies {
  fetch?: typeof fetch;
  currentVersion?: () => Promise<string>;
  config?: () => Promise<AutoUpdateConfig>;
  token?: UpdateTokenProvider;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
export async function updateConfig(): Promise<AutoUpdateConfig> {
  return (await readAppConfig(process.env.READABLE_DATA_DIR ?? resolve('.readable-studio'))).autoUpdate ?? { enabled: false, serverUrl: null };
}
export async function checkForUpdate(deps: UpdateCheckDependencies = {}, automatic = false): Promise<UpdateCheckResult> {
  const config = await (deps.config ?? updateConfig)();
  if (automatic && !config.enabled) return { unavailable: 'disabled' };
  if (!config.serverUrl) return { unavailable: 'not-configured' };
  try {
    const manifest = await new DatabricksUpdateSource(config.serverUrl, deps.token, deps.fetch).latest();
    const current = await (deps.currentVersion ?? (async () => (await readCurrentAppVersionInfo()).version))();
    const comparison = compareUpdateVersions(manifest.version, current);
    if (comparison === null) return { unavailable: 'invalid-response' };
    return { current, latest: manifest.version, isNewer: comparison > 0, assetName: manifest.fileName, assetSize: manifest.size,
      sha256: manifest.sha256, releaseUrl: config.serverUrl, notes: manifest.notes, checkedAt: new Date().toISOString() };
  } catch (error) {
    return error instanceof UpdateSourceError ? { unavailable: error.reason, ...(error.host ? { host: error.host } : {}) } : { unavailable: 'unreachable' };
  }
}
export function registerUpdateRoutes(app: Express, deps: UpdateCheckDependencies = {}): void {
  app.get('/api/update/check', async (req, res) => {
    const download = process.env.READABLE_UPDATE_ROOT ? updateDownload(process.env.READABLE_UPDATE_ROOT) : undefined;
    download?.checking();
    const result = await checkForUpdate(deps, req.query.automatic === '1');
    await download?.checked(result);
    res.json(result);
  });
  app.post('/api/update/health', async (req, res) => {
    const value: unknown = req.body?.serverUrl ?? (await (deps.config ?? updateConfig)()).serverUrl;
    try {
      if (typeof value !== 'string') throw new UpdateSourceError('not-configured');
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new UpdateSourceError('invalid-response');
      await new DatabricksUpdateSource(url.href.replace(/\/+$/, ''), deps.token, deps.fetch).health();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json(error instanceof UpdateSourceError ? { error: error.reason, host: error.host } : { error: 'invalid-response' });
    }
  });
}
