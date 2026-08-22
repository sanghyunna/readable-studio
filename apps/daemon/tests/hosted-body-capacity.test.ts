import { describe, expect, it } from 'vitest';

import {
  createHostedBodyCapacity,
  HOSTED_BODY_CAPACITY_LIMITS,
} from '../src/hosted-body-capacity.js';
import { HostedRuntimeError } from '../src/hosted-runtime-registry.js';

const MiB = 1024 * 1024;

function expectHostedError(
  action: () => unknown,
  code: HostedRuntimeError['code'],
  secret?: string,
): void {
  try {
    action();
    throw new Error('expected hosted capacity error');
  } catch (error) {
    expect(error).toBeInstanceOf(HostedRuntimeError);
    expect(error).toMatchObject({ code });
    if (secret != null) expect((error as Error).message).not.toContain(secret);
  }
}

describe('hosted body capacity', () => {
  it('enforces the two-request and 200 MiB per-user boundaries', () => {
    const capacity = createHostedBodyCapacity();
    const userKey = 'sensitive-user-key';
    const first = capacity.reserve(userKey, 120 * MiB);
    const second = capacity.reserve(userKey, 80 * MiB);

    expectHostedError(
      () => capacity.reserve(userKey, 0),
      'HOSTED_OVERLOADED',
      userKey,
    );

    first.release();
    expectHostedError(
      () => capacity.reserve(userKey, 121 * MiB),
      'HOSTED_OVERLOADED',
      userKey,
    );
    const replacement = capacity.reserve(userKey, 120 * MiB);
    expectHostedError(
      () => capacity.reserve(userKey, 1),
      'HOSTED_OVERLOADED',
      userKey,
    );

    second.release();
    replacement.release();
  });

  it('rejects one oversized body as quota rather than shared capacity', () => {
    const capacity = createHostedBodyCapacity();
    const userKey = 'oversized-body-owner';

    expectHostedError(
      () => capacity.reserve(userKey, HOSTED_BODY_CAPACITY_LIMITS.userBytes + 1),
      'HOSTED_QUOTA_EXCEEDED',
      userKey,
    );
  });

  it('enforces 64 concurrent requests globally and releases exactly once', () => {
    const capacity = createHostedBodyCapacity();
    const reservations = Array.from(
      { length: HOSTED_BODY_CAPACITY_LIMITS.globalRequests },
      (_, index) => capacity.reserve(`user-${Math.floor(index / 2)}`, 1),
    );

    expectHostedError(
      () => capacity.reserve('next-user', 1),
      'HOSTED_CAPACITY_EXHAUSTED',
      'next-user',
    );

    reservations[0]!.release();
    reservations[0]!.release();
    const replacement = capacity.reserve('next-user', 1);
    expectHostedError(
      () => capacity.reserve('another-user', 1),
      'HOSTED_CAPACITY_EXHAUSTED',
    );
    replacement.release();
    for (const reservation of reservations) reservation.release();
  });

  it('enforces the 2 GiB global byte boundary independently of request count', () => {
    const capacity = createHostedBodyCapacity();
    const reservations = Array.from(
      { length: 10 },
      (_, index) => capacity.reserve(`large-user-${index}`, 200 * MiB),
    );
    reservations.push(capacity.reserve('remainder-user', 48 * MiB));

    expectHostedError(
      () => capacity.reserve('overflow-user', 1),
      'HOSTED_CAPACITY_EXHAUSTED',
      'overflow-user',
    );

    for (const reservation of reservations) reservation.release();
  });

  it('rejects invalid reservations without consuming capacity', () => {
    const capacity = createHostedBodyCapacity();

    for (const [userKey, bytes] of [
      ['', 1],
      ['user', -1],
      ['user', 1.5],
      ['user', Number.NaN],
    ] as const) {
      expect(() => capacity.reserve(userKey, bytes)).toThrow(TypeError);
    }

    const first = capacity.reserve('user', 0);
    const second = capacity.reserve('user', 0);
    first.release();
    second.release();
  });
});
