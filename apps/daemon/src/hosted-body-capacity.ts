import { HostedRuntimeError } from './hosted-runtime-registry.js';

export const HOSTED_BODY_CAPACITY_LIMITS = Object.freeze({
  globalBytes: 2 * 1024 * 1024 * 1024,
  globalRequests: 64,
  userBytes: 200 * 1024 * 1024,
  userRequests: 2,
});

export interface HostedBodyReservation {
  release(): void;
}

export interface HostedBodyCapacity {
  reserve(userKey: string, bytes: number): HostedBodyReservation;
}

interface UserCapacity {
  bytes: number;
  requests: number;
}

export function createHostedBodyCapacity(): HostedBodyCapacity {
  const users = new Map<string, UserCapacity>();
  let globalBytes = 0;
  let globalRequests = 0;

  return {
    reserve(userKey, bytes) {
      validateReservation(userKey, bytes);
      if (bytes > HOSTED_BODY_CAPACITY_LIMITS.userBytes) {
        throw new HostedRuntimeError(
          'HOSTED_QUOTA_EXCEEDED',
          'hosted request body exceeds the byte limit',
        );
      }

      const user = users.get(userKey) ?? { bytes: 0, requests: 0 };
      if (
        user.requests >= HOSTED_BODY_CAPACITY_LIMITS.userRequests
        || user.bytes + bytes > HOSTED_BODY_CAPACITY_LIMITS.userBytes
      ) {
        throw new HostedRuntimeError('HOSTED_OVERLOADED', 'hosted user body capacity is exhausted');
      }
      if (
        globalRequests >= HOSTED_BODY_CAPACITY_LIMITS.globalRequests
        || globalBytes + bytes > HOSTED_BODY_CAPACITY_LIMITS.globalBytes
      ) {
        throw new HostedRuntimeError(
          'HOSTED_CAPACITY_EXHAUSTED',
          'hosted process body capacity is exhausted',
        );
      }

      user.requests += 1;
      user.bytes += bytes;
      users.set(userKey, user);
      globalRequests += 1;
      globalBytes += bytes;

      let released = false;
      return Object.freeze({
        release(): void {
          if (released) return;
          released = true;
          user.requests -= 1;
          user.bytes -= bytes;
          globalRequests -= 1;
          globalBytes -= bytes;
          if (user.requests === 0) users.delete(userKey);
        },
      });
    },
  };
}

function validateReservation(userKey: string, bytes: number): void {
  const encodedUserKey = typeof userKey === 'string' ? Buffer.from(userKey, 'utf8') : null;
  if (
    encodedUserKey == null
    || encodedUserKey.length < 1
    || encodedUserKey.length > 1_024
    || encodedUserKey.toString('utf8') !== userKey
  ) {
    throw new TypeError('hosted body reservation identity is invalid');
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError('hosted body reservation bytes must be a non-negative safe integer');
  }
}
