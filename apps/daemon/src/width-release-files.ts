import { createHash } from 'node:crypto';
import type { RestoreProjectFileWidthReleaseRequest } from '@readable-studio/contracts';
import { editWidthRelease, type WidthReleaseConflict, type WidthReleaseSuccess } from '@readable-studio/html-edit';

export const widthReleaseContentHash = (source: string | Buffer): string => createHash('sha256').update(source).digest('hex');

export class WidthReleaseFileConflictError extends Error {
  constructor(readonly conflict: WidthReleaseConflict) {
    super(`Cannot restore or inspect width release (${conflict.reason}${conflict.targetId ? `: ${conflict.targetId}` : ''}). Reload the file and inspect its sizing; resolve changed declarations or metadata explicitly before restoring.`);
  }
}

function success(result: ReturnType<typeof editWidthRelease>): WidthReleaseSuccess {
  if (!result.ok) throw new WidthReleaseFileConflictError(result.conflict);
  return result;
}

export function inspectFileWidthReleases(source: string): WidthReleaseSuccess {
  return success(editWidthRelease(source, { kind: 'inspect' }));
}

/** Boundary validation only; the shared engine owns record/CSS validation. */
export function isWidthReleaseRestoreRequest(value: unknown): value is RestoreProjectFileWidthReleaseRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['name', 'expectedContentSha256', 'widthRelease'].includes(key))
    || typeof body.name !== 'string' || !body.name
    || typeof body.expectedContentSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(body.expectedContentSha256)
    || !body.widthRelease || typeof body.widthRelease !== 'object' || Array.isArray(body.widthRelease)) return false;
  const operation = body.widthRelease as Record<string, unknown>;
  if (operation.kind !== 'restore') return false;
  if (operation.all === true) return Object.keys(operation).every((key) => ['kind', 'all'].includes(key));
  if (Object.keys(operation).some((key) => !['kind', 'target'].includes(key))
    || !operation.target || typeof operation.target !== 'object' || Array.isArray(operation.target)) return false;
  const target = operation.target as Record<string, unknown>;
  return Object.keys(target).every((key) => ['targetId', 'tag', 'releaseId'].includes(key))
    && typeof target.targetId === 'string' && target.targetId.length > 0
    && (target.tag === undefined || (typeof target.tag === 'string' && target.tag.length > 0))
    && (target.releaseId === undefined || (typeof target.releaseId === 'string' && target.releaseId.length > 0));
}

/** Stage the complete transaction in memory. The caller performs one hash-guarded write. */
export function restoreFileWidthReleases(source: string, operation: RestoreProjectFileWidthReleaseRequest['widthRelease']) {
  const targets = operation.all
    ? inspectFileWidthReleases(source).records.map((record) => ({ targetId: record.targetId, tag: record.tag, releaseId: record.id }))
    : [operation.target];
  let result = inspectFileWidthReleases(source);
  for (const target of targets) result = success(editWidthRelease(result.source, { kind: 'restore', target }));
  return { ...result, restoredTargetIds: targets.map((target) => target.targetId) };
}
