import type { Express } from 'express';
import { compareUpdateVersions, type UpdateCheckResult, type UpdateUnavailableReason } from '@readable-studio/contracts';
import { readCurrentAppVersionInfo } from './app-version.js';

export const UPDATE_RELEASE_API = 'https://api.github.com/repos/sanghyunna/readable-studio/releases/latest';
const RELEASE_ROOT = 'https://github.com/sanghyunna/readable-studio/releases/';
const TIMEOUT_MS = 4000;
interface ReleaseAsset { name: string; size: number; browser_download_url: string }
export interface UpdateCheckDependencies {
  fetch?: typeof fetch;
  currentVersion?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
class Unavailable extends Error {
  constructor(readonly reason: UpdateUnavailableReason) { super(reason); }
}
function releaseUrl(value: unknown, kind: 'tag' | 'download'): value is string {
  if (typeof value !== 'string' || !value.startsWith(`${RELEASE_ROOT}${kind}/`)) return false;
  try { const url = new URL(value); return url.origin === 'https://github.com' && !url.username && !url.password; }
  catch { return false; }
}
function asset(value: unknown): value is ReleaseAsset {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as ReleaseAsset;
  return typeof candidate.name === 'string' && Number.isSafeInteger(candidate.size) && candidate.size > 0
    && releaseUrl(candidate.browser_download_url, 'download');
}
function bodyHash(body: string, name: string): string | null {
  // Published v1.2.0/v1.2.1 format, scoped to the exact asset name.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('SHA-256 \\(\u0060' + escaped + '\u0060\\):\\s*\u0060\u0060\u0060text\\r?\\n([a-fA-F0-9]{64})\\r?\\n\u0060\u0060\u0060').exec(body)?.[1]?.toLowerCase() ?? null;
}
function sumsHash(text: string, name: string): string | null {
  const matches = text.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/.exec(line);
    return match?.[2] === name ? [match[1]!.toLowerCase()] : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** One deadline covers metadata, checksum fetch, and response bodies. */
export async function checkForUpdate(deps: UpdateCheckDependencies = {}, automatic = false): Promise<UpdateCheckResult> {
  if (automatic && (deps.env ?? process.env).READABLE_DISABLE_UPDATE_CHECK === '1') return { unavailable: 'disabled' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<UpdateCheckResult>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ unavailable: 'timeout' }); }, deps.timeoutMs ?? TIMEOUT_MS);
  });
  const run = async (): Promise<UpdateCheckResult> => {
    try {
      const current = await (deps.currentVersion ?? (async () => (await readCurrentAppVersionInfo()).version))();
      const get = async (url: string) => {
        const response = await (deps.fetch ?? fetch)(url, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } });
        if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') throw new Unavailable('rate-limited');
        if (!response.ok) throw new Unavailable('offline');
        return response;
      };
      const response = await get(UPDATE_RELEASE_API);
      let data: unknown;
      try { data = await response.json(); } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new Unavailable('malformed');
      }
      if (!data || typeof data !== 'object') throw new Unavailable('malformed');
      const release = data as Record<string, unknown>;
      if (typeof release.tag_name !== 'string' || typeof release.body !== 'string' || !releaseUrl(release.html_url, 'tag') || !Array.isArray(release.assets)) throw new Unavailable('malformed');
      const latest = release.tag_name.replace(/^v/, '');
      const comparison = compareUpdateVersions(latest, current);
      if (comparison === null) throw new Unavailable('malformed');
      const assets = release.assets.filter(asset);
      if (assets.length !== release.assets.length) throw new Unavailable('malformed');
      // Portable Windows x64 ZIP only; version is never inferred from its name.
      const portable = assets.filter((entry) => /^Readable-Studio(?:-.*)?-win-x64-portable\.zip$/i.test(entry.name));
      if (portable.length !== 1) throw new Unavailable('malformed');
      const selected = portable[0]!;
      const sums = assets.find((entry) => /^SHA256SUMS(?:\.txt)?$/i.test(entry.name));
      const sha256 = sums
        ? sumsHash(await (await get(sums.browser_download_url)).text(), selected.name)
        : bodyHash(release.body, selected.name);
      if (!sha256) throw new Unavailable('malformed');
      return { current, latest, isNewer: comparison > 0, assetName: selected.name, assetSize: selected.size,
        sha256, releaseUrl: release.html_url, notes: release.body, checkedAt: new Date().toISOString() };
    } catch (error) {
      return { unavailable: controller.signal.aborted ? 'timeout' : error instanceof Unavailable ? error.reason : 'offline' };
    }
  };
  try { return await Promise.race([run(), timeout]); }
  finally { clearTimeout(timer); }
}

export function registerUpdateRoutes(app: Express, deps: UpdateCheckDependencies = {}): void {
  app.get('/api/update/check', async (req, res) => {
    res.json(await checkForUpdate(deps, req.query.automatic === '1'));
  });
}
