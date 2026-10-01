/** Expected check failures are results, never UI exceptions. */
export type UpdateUnavailableReason = 'offline' | 'rate-limited' | 'malformed' | 'timeout' | 'disabled';
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
export interface UpdateCheckUnavailable { unavailable: UpdateUnavailableReason }
export type UpdateCheckResult = UpdateCheckAvailable | UpdateCheckUnavailable;

export interface UpdateApplyAccepted { status: 'applying'; targetVersion: string }
export interface UpdateApplyError { error: string }
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
