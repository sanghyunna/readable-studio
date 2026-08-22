import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const HOSTED_PREVIEW_SCOPE_LIMITS = Object.freeze({
  global: 2_048,
  perUser: 32,
  maxTtlMs: 10 * 60 * 1_000,
});

const MAX_BINDING_BYTES = 1_024;
const TOKEN_PATTERN = /^odpv_[A-Za-z0-9_-]{43}$/u;
const BROWSER_PROOF_PATTERN = /^odpb_[A-Za-z0-9_-]{43}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export class HostedPreviewScopeError extends Error {
  readonly code: 'HOSTED_CAPACITY_EXHAUSTED' | 'HOSTED_OVERLOADED' | 'INTERNAL_ERROR';

  constructor(code: HostedPreviewScopeError['code'], message: string) {
    super(message);
    this.name = 'HostedPreviewScopeError';
    this.code = code;
  }
}

export interface HostedPreviewScopeBinding {
  readonly userKey: string;
  readonly generation: number;
  readonly projectId: string;
  readonly filePath: string;
}

export interface HostedPreviewScopeGrant {
  /** Secret transported only in an HttpOnly, scope-path cookie. */
  readonly browserProof: string;
  readonly token: string;
  readonly url: string;
  readonly expiresAt: string;
}

export interface HostedPreviewScopeRegistry {
  mint(
    binding: HostedPreviewScopeBinding,
    options?: { readonly ttlMs?: number },
  ): HostedPreviewScopeGrant;
  validate(token: string, binding: HostedPreviewScopeBinding, browserProof: string): boolean;
  resolve(
    token: string,
    binding: Pick<HostedPreviewScopeBinding, 'projectId'> & { readonly browserProof: string },
  ): Readonly<HostedPreviewScopeBinding> | null;
  revokeGeneration(binding: Pick<HostedPreviewScopeBinding, 'userKey' | 'generation'>): number;
  dispose(): void;
}

type StoredScope = {
  readonly binding: Readonly<HostedPreviewScopeBinding>;
  readonly browserProofHash: string;
  readonly expiresAtMs: number;
  readonly timer: NodeJS.Timeout;
};

export function createHostedPreviewScopeRegistry(options: {
  readonly now?: () => number;
} = {}): HostedPreviewScopeRegistry {
  const now = options.now ?? Date.now;
  const scopes = new Map<string, StoredScope>();
  const scopesByUser = new Map<string, Set<string>>();
  let disposed = false;

  const revokeHash = (tokenHash: string): boolean => {
    const scope = scopes.get(tokenHash);
    if (!scope) return false;
    clearTimeout(scope.timer);
    scopes.delete(tokenHash);
    const userScopes = scopesByUser.get(scope.binding.userKey);
    userScopes?.delete(tokenHash);
    if (userScopes?.size === 0) scopesByUser.delete(scope.binding.userKey);
    return true;
  };

  const removeExpired = (at: number): void => {
    for (const [tokenHash, scope] of scopes) {
      if (at >= scope.expiresAtMs) revokeHash(tokenHash);
    }
  };

  const mint = (
    binding: HostedPreviewScopeBinding,
    mintOptions: { readonly ttlMs?: number } = {},
  ): HostedPreviewScopeGrant => {
    if (disposed) {
      throw new HostedPreviewScopeError('INTERNAL_ERROR', 'hosted preview scope registry is closed');
    }
    requireValidBinding(binding);
    const ttlMs = mintOptions.ttlMs ?? HOSTED_PREVIEW_SCOPE_LIMITS.maxTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > HOSTED_PREVIEW_SCOPE_LIMITS.maxTtlMs) {
      throw new TypeError('hosted preview scope lifetime is invalid');
    }
    const currentTime = now();
    const expiresAtMs = currentTime + ttlMs;
    if (
      !Number.isSafeInteger(currentTime)
      || currentTime < 0
      || !Number.isSafeInteger(expiresAtMs)
      || !Number.isFinite(new Date(expiresAtMs).getTime())
    ) throw new TypeError('hosted preview scope clock is invalid');

    removeExpired(currentTime);
    const userScopes = scopesByUser.get(binding.userKey);
    if ((userScopes?.size ?? 0) >= HOSTED_PREVIEW_SCOPE_LIMITS.perUser) {
      throw new HostedPreviewScopeError(
        'HOSTED_OVERLOADED',
        'hosted user preview scope capacity is exhausted',
      );
    }
    if (scopes.size >= HOSTED_PREVIEW_SCOPE_LIMITS.global) {
      throw new HostedPreviewScopeError(
        'HOSTED_CAPACITY_EXHAUSTED',
        'hosted process preview scope capacity is exhausted',
      );
    }

    let token: string;
    let tokenHash: string;
    do {
      token = `odpv_${randomBytes(32).toString('base64url')}`;
      tokenHash = hashToken(token);
    } while (scopes.has(tokenHash));
    const browserProof = `odpb_${randomBytes(32).toString('base64url')}`;

    const timer = setTimeout(() => revokeHash(tokenHash), ttlMs);
    timer.unref?.();
    const storedBinding = Object.freeze({ ...binding });
    scopes.set(tokenHash, {
      binding: storedBinding,
      browserProofHash: hashToken(browserProof),
      expiresAtMs,
      timer,
    });
    const nextUserScopes = userScopes ?? new Set<string>();
    nextUserScopes.add(tokenHash);
    scopesByUser.set(binding.userKey, nextUserScopes);

    return Object.freeze({
      browserProof,
      token,
      url: previewUrl(token, storedBinding),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  };

  const validate = (
    token: string,
    binding: HostedPreviewScopeBinding,
    browserProof: string,
  ): boolean => {
    if (!validBinding(binding)) return false;
    const scope = resolveScope(token, browserProof);
    if (scope == null) return false;
    return scope.binding.userKey === binding.userKey
      && scope.binding.generation === binding.generation
      && scope.binding.projectId === binding.projectId
      && scope.binding.filePath === binding.filePath;
  };

  const resolve = (
    token: string,
    binding: Pick<HostedPreviewScopeBinding, 'projectId'> & { readonly browserProof: string },
  ): Readonly<HostedPreviewScopeBinding> | null => {
    if (!validProjectId(binding?.projectId)) return null;
    const scope = resolveScope(token, binding.browserProof);
    if (scope == null || scope.binding.projectId !== binding.projectId) return null;
    return scope.binding;
  };

  const resolveScope = (token: string, browserProof: string): StoredScope | null => {
    if (
      disposed
      || !TOKEN_PATTERN.test(token)
      || !BROWSER_PROOF_PATTERN.test(browserProof)
    ) return null;
    const tokenHash = hashToken(token);
    const scope = scopes.get(tokenHash);
    if (!scope) return null;
    if (!safeHashEqual(scope.browserProofHash, hashToken(browserProof))) return null;
    const currentTime = now();
    if (!Number.isSafeInteger(currentTime) || currentTime < 0 || currentTime >= scope.expiresAtMs) {
      revokeHash(tokenHash);
      return null;
    }
    return scope;
  };

  const revokeGeneration = (
    binding: Pick<HostedPreviewScopeBinding, 'userKey' | 'generation'>,
  ): number => {
    if (!validOwnerGeneration(binding)) return 0;
    const userScopes = scopesByUser.get(binding.userKey);
    if (!userScopes) return 0;
    let revoked = 0;
    for (const tokenHash of [...userScopes]) {
      const scope = scopes.get(tokenHash);
      if (scope?.binding.generation === binding.generation && revokeHash(tokenHash)) revoked += 1;
    }
    return revoked;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const tokenHash of [...scopes.keys()]) revokeHash(tokenHash);
  };

  return { mint, validate, resolve, revokeGeneration, dispose };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function previewUrl(token: string, binding: HostedPreviewScopeBinding): string {
  const file = binding.filePath.split('/').map(encodeURIComponent).join('/');
  return `/api/projects/${encodeURIComponent(binding.projectId)}/preview/${token}/${file}`;
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_BINDING_BYTES
    && !CONTROL_CHARACTERS.test(value);
}

function validOwnerGeneration(
  value: Pick<HostedPreviewScopeBinding, 'userKey' | 'generation'>,
): boolean {
  return value != null
    && boundedString(value.userKey)
    && Number.isSafeInteger(value.generation)
    && value.generation >= 1;
}

function validProjectId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && /^(?!\.+$)[A-Za-z0-9._-]+$/u.test(value);
}

function canonicalRelativeFile(value: unknown): value is string {
  return boundedString(value)
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes(':')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validBinding(value: HostedPreviewScopeBinding): boolean {
  return value != null
    && validOwnerGeneration(value)
    && validProjectId(value.projectId)
    && canonicalRelativeFile(value.filePath);
}

function requireValidBinding(value: HostedPreviewScopeBinding): void {
  if (!validBinding(value)) throw new TypeError('hosted preview scope binding is invalid');
}
