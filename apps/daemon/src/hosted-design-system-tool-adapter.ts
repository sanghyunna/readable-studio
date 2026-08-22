import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  HostedDesignSystemReadResponse,
  HostedDesignSystemReadV1,
} from '@readable-studio/contracts';

export const HOSTED_DESIGN_SYSTEM_READ_ENDPOINT = '/api/tools/design-systems/read' as const;
export const HOSTED_DESIGN_SYSTEM_GRANT_MAX_TTL_MS = 31 * 60 * 1_000;
export const HOSTED_DESIGN_SYSTEM_GRANT_GLOBAL_LIMIT = 32;
export const HOSTED_DESIGN_SYSTEM_CONTENT_MAX_BYTES = 4 * 1024 * 1024;

const MAX_PATH_BYTES = 1_024;
const MAX_BINDING_BYTES = 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const TOOL_TOKEN_PATTERN = /^odds_[A-Za-z0-9_-]{43}$/u;
const TOOL_CARRIER_PATTERN = /^odpi_[A-Za-z0-9_-]{43}$/u;
const DUMMY_SECRET_HASH = createHash('sha256').update('invalid hosted tool carrier').digest();

export type HostedDesignSystemToolAdapterErrorCode =
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'HOSTED_CAPACITY_EXHAUSTED'
  | 'INTERNAL_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED';

export class HostedDesignSystemToolAdapterError extends Error {
  readonly code: HostedDesignSystemToolAdapterErrorCode;

  constructor(code: HostedDesignSystemToolAdapterErrorCode, message: string) {
    super(message);
    this.name = 'HostedDesignSystemToolAdapterError';
    this.code = code;
  }
}

export interface HostedDesignSystemToolCatalogueEntry {
  readonly id: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

export interface HostedDesignSystemToolBinding {
  readonly userKey: string;
  readonly runId: string;
  readonly projectId: string;
  readonly endpoint: typeof HOSTED_DESIGN_SYSTEM_READ_ENDPOINT;
  readonly generation: number;
  readonly designSystemId: string;
}

export interface HostedDesignSystemToolAuthInput {
  readonly token: string | null;
  readonly carrierToken: string | null;
  readonly cookiePresent: boolean;
  readonly csrfPresent: boolean;
  readonly origin: string | null;
}

export interface HostedDesignSystemToolGrant {
  readonly token: string;
  readonly expiresAt: string;
}

export interface HostedDesignSystemToolBindingLease {
  release(): void | Promise<void>;
}

export type HostedDesignSystemToolBindingValidator = (
  binding: HostedDesignSystemToolBinding,
) => HostedDesignSystemToolBindingLease | null | Promise<HostedDesignSystemToolBindingLease | null>;

type StoredGrant = {
  readonly tokenHash: string;
  readonly carrierHash: Buffer;
  readonly binding: HostedDesignSystemToolBinding;
  readonly allowedPaths: ReadonlySet<string>;
  readonly expiresAtMs: number;
  readonly timer: NodeJS.Timeout;
};

type FixedDesignSystem = {
  readonly files: ReadonlyMap<string, string>;
};

function fail(
  code: HostedDesignSystemToolAdapterErrorCode,
  message: string,
): never {
  throw new HostedDesignSystemToolAdapterError(code, message);
}

function secretHash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function secretHashKey(secret: string): string {
  return secretHash(secret).toString('hex');
}

function sameSecretHash(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createSecret(prefix: 'odds_'): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !CONTROL_CHARACTERS.test(value);
}

function canonicalRelativePath(value: unknown): value is string {
  return boundedString(value, MAX_PATH_BYTES)
    && !value.startsWith('/')
    && !value.includes('\\')
    && !/^[A-Za-z]:/u.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validDesignSystemId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && /^(?!\.+$)[A-Za-z0-9._-]+$/u.test(value);
}

function validateBinding(binding: HostedDesignSystemToolBinding): void {
  if (
    !boundedString(binding.userKey, MAX_BINDING_BYTES)
    || !boundedString(binding.runId, MAX_BINDING_BYTES)
    || !boundedString(binding.projectId, MAX_BINDING_BYTES)
    || binding.endpoint !== HOSTED_DESIGN_SYSTEM_READ_ENDPOINT
    || !Number.isSafeInteger(binding.generation)
    || binding.generation < 1
    || !validDesignSystemId(binding.designSystemId)
  ) fail('INTERNAL_ERROR', 'design-system grant binding is invalid');
}

function fixedCatalogue(
  entries: readonly HostedDesignSystemToolCatalogueEntry[],
): ReadonlyMap<string, FixedDesignSystem> {
  const catalogue = new Map<string, FixedDesignSystem>();
  for (const entry of entries) {
    if (!validDesignSystemId(entry.id) || catalogue.has(entry.id) || !Array.isArray(entry.files)) {
      fail('INTERNAL_ERROR', 'design-system catalogue is invalid');
    }
    const files = new Map<string, string>();
    for (const file of entry.files) {
      if (
        !canonicalRelativePath(file.path)
        || files.has(file.path)
        || typeof file.content !== 'string'
        || Buffer.byteLength(file.content, 'utf8') > HOSTED_DESIGN_SYSTEM_CONTENT_MAX_BYTES
      ) fail('INTERNAL_ERROR', 'design-system catalogue is invalid');
      files.set(file.path, file.content);
    }
    catalogue.set(entry.id, { files });
  }
  return catalogue;
}

function exactReadRequest(value: unknown): HostedDesignSystemReadV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('BAD_REQUEST', 'design-system read request is invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (
    !keys.includes('path')
    || keys.some((key) => key !== 'path' && key !== 'designSystemId')
    || !canonicalRelativePath((value as Record<string, unknown>).path)
  ) fail('BAD_REQUEST', 'design-system read request is invalid');
  const designSystemId = (value as Record<string, unknown>).designSystemId;
  if (designSystemId === undefined) return { path: (value as { path: string }).path };
  if (!validDesignSystemId(designSystemId)) {
    fail('BAD_REQUEST', 'design-system read request is invalid');
  }
  return { path: (value as { path: string }).path, designSystemId };
}

export function createHostedDesignSystemToolAdapter(options: {
  readonly catalogue: readonly HostedDesignSystemToolCatalogueEntry[];
  readonly now?: () => number;
  /** Server-owned generation/ownership validation. Without it, every read fails closed. */
  readonly validateBinding?: HostedDesignSystemToolBindingValidator;
}) {
  const catalogue = fixedCatalogue(options.catalogue);
  const grants = new Map<string, StoredGrant>();
  const grantsByUser = new Map<string, string>();
  const now = options.now ?? Date.now;
  let disposed = false;

  const revokeHash = (hash: string): boolean => {
    const stored = grants.get(hash);
    if (!stored) return false;
    clearTimeout(stored.timer);
    stored.carrierHash.fill(0);
    grants.delete(hash);
    if (grantsByUser.get(stored.binding.userKey) === hash) {
      grantsByUser.delete(stored.binding.userKey);
    }
    return true;
  };

  const removeExpired = (at: number): void => {
    for (const [hash, grant] of grants) {
      if (at >= grant.expiresAtMs) revokeHash(hash);
    }
  };

  const mintGrant = (
    binding: HostedDesignSystemToolBinding,
    grantOptions: {
      /** Existing per-turn Pi broker token; never persisted or returned by this adapter. */
      readonly carrierToken: string;
      readonly ttlMs?: number;
    },
  ): HostedDesignSystemToolGrant => {
    if (disposed) fail('INTERNAL_ERROR', 'design-system tool adapter is closed');
    validateBinding(binding);
    const fixed = catalogue.get(binding.designSystemId);
    if (!fixed) fail('INTERNAL_ERROR', 'design-system grant catalogue is invalid');
    const ttlMs = grantOptions.ttlMs ?? HOSTED_DESIGN_SYSTEM_GRANT_MAX_TTL_MS;
    if (!TOOL_CARRIER_PATTERN.test(grantOptions.carrierToken)) {
      fail('INTERNAL_ERROR', 'design-system grant carrier is invalid');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > HOSTED_DESIGN_SYSTEM_GRANT_MAX_TTL_MS) {
      fail('INTERNAL_ERROR', 'design-system grant lifetime is invalid');
    }
    const currentTime = now();
    if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
      fail('INTERNAL_ERROR', 'design-system grant clock is invalid');
    }
    removeExpired(currentTime);
    const previousHash = grantsByUser.get(binding.userKey);
    if (previousHash === undefined && grants.size >= HOSTED_DESIGN_SYSTEM_GRANT_GLOBAL_LIMIT) {
      fail('HOSTED_CAPACITY_EXHAUSTED', 'hosted design-system grant capacity is exhausted');
    }
    const carrierHash = secretHash(grantOptions.carrierToken);
    if ([...grants].some(([hash, grant]) => (
      hash !== previousHash && sameSecretHash(grant.carrierHash, carrierHash)
    ))) {
      carrierHash.fill(0);
      fail('INTERNAL_ERROR', 'design-system grant carrier is already active');
    }

    let token: string;
    let tokenHash: string;
    do {
      token = createSecret('odds_');
      tokenHash = secretHashKey(token);
    } while (grants.has(tokenHash));
    const expiresAtMs = currentTime + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      fail('INTERNAL_ERROR', 'design-system grant lifetime is invalid');
    }
    const timer = setTimeout(() => revokeHash(tokenHash), ttlMs);
    timer.unref?.();
    if (previousHash !== undefined) revokeHash(previousHash);
    grants.set(tokenHash, {
      tokenHash,
      carrierHash,
      binding: Object.freeze({ ...binding }),
      allowedPaths: new Set(fixed.files.keys()),
      expiresAtMs,
      timer,
    });
    grantsByUser.set(binding.userKey, tokenHash);
    return Object.freeze({
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  };

  const authorize = (auth: HostedDesignSystemToolAuthInput): StoredGrant => {
    if (
      disposed
      || !auth
      || auth.cookiePresent !== false
      || auth.csrfPresent !== false
      || auth.origin !== null
      || typeof auth.token !== 'string'
      || !TOOL_TOKEN_PATTERN.test(auth.token)
      || typeof auth.carrierToken !== 'string'
      || !TOOL_CARRIER_PATTERN.test(auth.carrierToken)
    ) fail('UNAUTHORIZED', 'design-system broker authorization failed');

    const grant = grants.get(secretHashKey(auth.token));
    const suppliedCarrierHash = secretHash(auth.carrierToken);
    const carrierMatches = sameSecretHash(
      grant?.carrierHash ?? DUMMY_SECRET_HASH,
      suppliedCarrierHash,
    );
    suppliedCarrierHash.fill(0);
    if (!grant || !carrierMatches) {
      fail('UNAUTHORIZED', 'design-system broker authorization failed');
    }
    if (now() >= grant.expiresAtMs) {
      revokeHash(grant.tokenHash);
      fail('UNAUTHORIZED', 'design-system broker authorization failed');
    }
    return grant;
  };

  const read = async (input: {
    readonly auth: HostedDesignSystemToolAuthInput;
    readonly readBody: () => unknown | Promise<unknown>;
  }): Promise<HostedDesignSystemReadResponse> => {
    const grant = authorize(input.auth);
    const validation = options.validateBinding == null
      ? null
      : await options.validateBinding(grant.binding);
    if (validation == null || typeof validation.release !== 'function') {
      fail('FORBIDDEN', 'design-system broker binding is not active');
    }
    try {
      let rawBody: unknown;
      try {
        rawBody = await input.readBody();
      } catch {
        fail('BAD_REQUEST', 'design-system read request is invalid');
      }
      const request = exactReadRequest(rawBody);
      if (
        request.designSystemId !== undefined
        && request.designSystemId !== grant.binding.designSystemId
      ) fail('FORBIDDEN', 'design-system is outside the broker grant');
      if (!grant.allowedPaths.has(request.path)) {
        fail('NOT_FOUND', 'design-system content is not available');
      }
      const content = catalogue.get(grant.binding.designSystemId)?.files.get(request.path);
      if (content === undefined) fail('NOT_FOUND', 'design-system content is not available');
      return Object.freeze({ content });
    } finally {
      await validation.release();
    }
  };

  const revoke = (token: string | null | undefined): boolean => (
    typeof token === 'string' && TOOL_TOKEN_PATTERN.test(token)
      ? revokeHash(secretHashKey(token))
      : false
  );

  const revokeGeneration = (binding: {
    readonly userKey: string;
    readonly generation: number;
  }): boolean => {
    const hash = grantsByUser.get(binding.userKey);
    const grant = hash === undefined ? undefined : grants.get(hash);
    return grant?.binding.generation === binding.generation ? revokeHash(grant.tokenHash) : false;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const hash of [...grants.keys()]) revokeHash(hash);
  };

  return { mintGrant, read, revoke, revokeGeneration, dispose };
}
