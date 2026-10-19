/** Expected check failures are results, never UI exceptions. */
export type UpdateUnavailableReason = 'unreachable' | 'invalid-response' | 'not-logged-in' | 'app-not-accessible' | 'forbidden' | 'no-release' | 'not-configured' | 'disabled' | 'timeout';
export interface AutoUpdateConfig { enabled: boolean; serverUrl: string | null }
/** Why an explicit connection check failed; finer than UpdateUnavailableReason so the UI can name the next action. */
export type UpdateConnectionFailure = 'invalid-url' | 'not-https' | 'dns' | 'unreachable' | 'timeout' | 'cli-missing' | 'not-logged-in'
  | 'workspace-not-found' | 'forbidden' | 'not-update-server' | 'app-stopped' | 'invalid-response';
export type UpdateConnectionStepName = 'url' | 'cli' | 'profiles' | 'workspace' | 'token' | 'health' | 'latest' | 'timeout';
/** One diagnostic step. `detail` is technical (paths, profile names, HTTP lines) and never carries a token. */
export interface UpdateConnectionStep { step: UpdateConnectionStepName; ok: boolean; detail: string; elapsedMs: number; httpStatus?: number }
/** POST /api/update/connection result; always HTTP 200, `ok` tells success. */
export interface UpdateConnectionReport {
  ok: boolean;
  serverUrl: string | null;
  failure?: UpdateConnectionFailure;
  /** Matched workspace on success; the workspace to sign in to for not-logged-in. */
  host?: string;
  profile?: string;
  cli?: { path: string; source: 'bundled' | 'installed' | 'override'; version: string | null };
  /** Latest published version; null means the server has no release yet. */
  latest?: string | null;
  timeoutMs: number;
  elapsedMs: number;
  steps: UpdateConnectionStep[];
}
export interface UpdateManifest {
  version: string;
  fileName: string;
  size: number;
  sha256: string;
  notes: string;
  publishedAt: string;
}
export interface UpdateStatus {
  /** Withdrawal, ready cancellation, or failed apply preparation clears staged bytes and returns idle with null version and zero received/total. */
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'ready' | 'failed';
  received: number;
  total: number;
  version: string | null;
  error: string | null;
  /** Most recent staged download removed because its release was withdrawn or replaced.
   * The stable event id lets clients remember dismissal without hiding later notices. */
  discardedDownload?: { id: string; version: string };
  /** Durable rollback event; matching version and digest must not be automatically offered again. */
  failedApply?: { id: string; version: string; sha256: string; releaseUrl: string };
  host?: string | undefined;
  /** Source of the offer, including a recovered verified download. */
  releaseUrl?: string | undefined;
  notes?: string | undefined;
  /** Apply preparation reports extracted app files independently of downloaded bytes. */
  extraction?: { completed: number; total: number; completedBytes?: number; totalBytes?: number } | undefined;
}
export interface UpdateCheckAvailable {
  current: string;
  latest: string;
  isNewer: boolean;
  assetName: string;
  assetSize: number;
  sha256: string;
  releaseUrl: string;
  notes: string;
  checkedAt: string;
}
export interface UpdateCheckUnavailable { unavailable: UpdateUnavailableReason; host?: string }
export type UpdateCheckResult = UpdateCheckAvailable | UpdateCheckUnavailable;

export interface UpdateApplyAccepted { status: 'applying'; targetVersion: string }
export interface UpdateApplyError {
  /** Includes release-withdrawn (409), invalid-package (500), version-mismatch (409), and disk-extract-failed (500). These discard staged bytes. */
  error: string;
}
export type UpdateApplyResult = UpdateApplyAccepted | UpdateApplyError | UpdateCheckUnavailable;

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** SemVer 2.0 precedence (build metadata ignored); null means invalid input. */
export function compareUpdateVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) return null;
  const ap = a[4]?.split('.') ?? [];
  const bp = b[4]?.split('.') ?? [];
  if ([...ap, ...bp].some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) return null;
  for (let i = 1; i <= 3; i++) {
    const av = BigInt(a[i]!); const bv = BigInt(b[i]!);
    if (av !== bv) return av > bv ? 1 : -1;
  }
  if (!ap.length && !bp.length) return 0;
  if (!ap.length) return 1;
  if (!bp.length) return -1;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i]; const bv = bp[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av); const bn = /^\d+$/.test(bv);
    if (an && bn) return BigInt(av) > BigInt(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}
