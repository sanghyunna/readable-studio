const PUBLICATION_TIMEOUT_MS = 120_000;
const IDLE_FLUSH_MS = 30_000;
const RETRY_BACKOFF_MS = [1_000, 4_000] as const;
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

export const HOSTED_DURABILITY_LIMITS = Object.freeze({
  idleFlushMs: IDLE_FLUSH_MS,
  maxAttempts: MAX_ATTEMPTS,
  publicationTimeoutMs: PUBLICATION_TIMEOUT_MS,
  retryBackoffMs: RETRY_BACKOFF_MS,
});

export type HostedDurabilityErrorCode =
  | 'HOSTED_DURABILITY_CLOSED'
  | 'HOSTED_DURABILITY_LANE_VIOLATION'
  | 'HOSTED_SNAPSHOT_PUBLICATION_FAILED'
  | 'HOSTED_SNAPSHOT_TIMEOUT';

export class HostedDurabilityError extends Error {
  constructor(
    readonly code: HostedDurabilityErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HostedDurabilityError';
  }
}

type TimerHandle = unknown;

export interface HostedDurabilityClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export interface HostedDurabilityCoordinator {
  readonly dirty: boolean;
  readonly poisoned: boolean;
  /** Runs inside the registry's existing per-user FIFO lane. */
  mutate<T>(mutation: () => T | Promise<T>): Promise<T>;
  /** Marks transient durable state and starts the fixed idle-flush timer. */
  markDirty(): void;
  /** Runs inside the existing lane, normally via requestIdleFlush. */
  flush(): Promise<void>;
  /** Flushes and permanently closes the coordinator during eviction/shutdown. */
  finalFlush(): Promise<void>;
}

export interface HostedDurabilityOptions {
  /**
   * Publishes and validates the complete snapshot. It deliberately receives no state.
   * After abort, it must prevent any completion marker/latest-pointer advance, clean
   * staging, and settle only once that guarantee holds.
   */
  readonly publish: (signal: AbortSignal) => Promise<unknown>;
  /** Enqueues the supplied flush in the registry's existing per-user FIFO lane. */
  readonly requestIdleFlush: (flush: () => Promise<void>) => void | Promise<void>;
  readonly poison: (error: HostedDurabilityError) => void;
  readonly clock?: HostedDurabilityClock;
}

const realClock: HostedDurabilityClock = {
  clearTimer(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now: Date.now,
  setTimer(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
};

class DeadlineElapsed extends Error {}

export function createHostedDurabilityCoordinator(
  options: HostedDurabilityOptions,
): HostedDurabilityCoordinator {
  if (typeof options.publish !== 'function') throw new TypeError('snapshot publisher is required');
  if (typeof options.requestIdleFlush !== 'function') {
    throw new TypeError('idle flush scheduler is required');
  }
  if (typeof options.poison !== 'function') throw new TypeError('poison callback is required');
  const clock = options.clock ?? realClock;
  validateClock(clock);

  let active = false;
  let closed = false;
  let dirty = false;
  let fatalError: HostedDurabilityError | null = null;
  let idleTimer: TimerHandle | null = null;

  const coordinator: HostedDurabilityCoordinator = {
    get dirty() {
      return dirty;
    },
    get poisoned() {
      return fatalError != null;
    },
    async mutate<T>(mutation: () => T | Promise<T>): Promise<T> {
      if (typeof mutation !== 'function') throw new TypeError('durable mutation is required');
      return inLane(async () => {
        const result = await mutation();
        dirty = true;
        await publishDirty();
        return result;
      });
    },
    markDirty() {
      assertUsable();
      dirty = true;
      if (!active) scheduleIdleFlush();
    },
    flush() {
      return inLane(publishDirty);
    },
    async finalFlush() {
      await inLane(async () => {
        await publishDirty();
        closed = true;
        clearIdleFlush();
      });
    },
  };

  return coordinator;

  async function inLane<T>(work: () => Promise<T>): Promise<T> {
    assertUsable();
    if (active) {
      throw new HostedDurabilityError(
        'HOSTED_DURABILITY_LANE_VIOLATION',
        'hosted durability operations must be serialized by the per-user FIFO lane',
      );
    }
    active = true;
    clearIdleFlush();
    try {
      return await work();
    } finally {
      active = false;
      if (dirty && fatalError == null && !closed) scheduleIdleFlush();
    }
  }

  function assertUsable(): void {
    if (fatalError != null) throw fatalError;
    if (closed) {
      throw new HostedDurabilityError(
        'HOSTED_DURABILITY_CLOSED',
        'hosted durability coordinator is closed',
      );
    }
  }

  async function publishDirty(): Promise<void> {
    if (!dirty) return;
    const startedAt = clock.now();
    if (!Number.isFinite(startedAt)) throw new TypeError('durability clock must be finite');
    const deadline = startedAt + PUBLICATION_TIMEOUT_MS;
    let lastFailure: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        await beforeDeadline(options.publish, deadline);
        dirty = false;
        return;
      } catch (error) {
        if (error instanceof DeadlineElapsed) {
          throw fail(new HostedDurabilityError(
            'HOSTED_SNAPSHOT_TIMEOUT',
            'hosted snapshot publication exceeded its 120 second deadline',
            error,
          ));
        }
        lastFailure = error;
      }

      const backoffMs = RETRY_BACKOFF_MS[attempt];
      if (backoffMs != null) {
        try {
          await waitBeforeDeadline(backoffMs, deadline);
        } catch (error) {
          throw fail(new HostedDurabilityError(
            'HOSTED_SNAPSHOT_TIMEOUT',
            'hosted snapshot publication exceeded its 120 second deadline',
            error,
          ));
        }
      }
    }

    throw fail(new HostedDurabilityError(
      'HOSTED_SNAPSHOT_PUBLICATION_FAILED',
      'hosted snapshot publication failed after three attempts',
      lastFailure,
    ));
  }

  async function beforeDeadline<T>(
    work: (signal: AbortSignal) => Promise<T>,
    deadline: number,
  ): Promise<T> {
    const remaining = deadline - clock.now();
    if (remaining <= 0) throw new DeadlineElapsed();
    const abort = new AbortController();
    const publication = Promise.resolve().then(() => work(abort.signal));
    let timeout: TimerHandle | null = null;
    try {
      try {
        return await Promise.race([
          publication,
          new Promise<never>((_resolve, reject) => {
            timeout = clock.setTimer(() => reject(new DeadlineElapsed()), remaining);
          }),
        ]);
      } catch (error) {
        if (!(error instanceof DeadlineElapsed)) throw error;
        abort.abort(error);
        // The abort contract makes settling this promise the confirmation that
        // an unacknowledged publication can no longer become authoritative.
        await publication.then(() => undefined, () => undefined);
        throw error;
      }
    } finally {
      if (timeout != null) clock.clearTimer(timeout);
    }
  }

  function waitBeforeDeadline(delayMs: number, deadline: number): Promise<void> {
    const remaining = deadline - clock.now();
    if (remaining <= delayMs) {
      return beforeDeadline(() => new Promise(() => {}), deadline);
    }
    return new Promise((resolve) => {
      clock.setTimer(resolve, delayMs);
    });
  }

  function fail(error: HostedDurabilityError): HostedDurabilityError {
    if (fatalError != null) return fatalError;
    fatalError = error;
    clearIdleFlush();
    try {
      options.poison(error);
    } catch {
      // The typed durability error remains authoritative even if cleanup reporting fails.
    }
    return error;
  }

  function scheduleIdleFlush(): void {
    clearIdleFlush();
    idleTimer = clock.setTimer(() => {
      idleTimer = null;
      if (!dirty || active || closed || fatalError != null) return;
      void Promise.resolve()
        .then(() => options.requestIdleFlush(coordinator.flush))
        .catch((cause: unknown) => {
          fail(new HostedDurabilityError(
            'HOSTED_SNAPSHOT_PUBLICATION_FAILED',
            'hosted idle snapshot flush could not enter the per-user lane',
            cause,
          ));
        });
    }, IDLE_FLUSH_MS);
    (idleTimer as { unref?: () => void } | null)?.unref?.();
  }

  function clearIdleFlush(): void {
    if (idleTimer == null) return;
    clock.clearTimer(idleTimer);
    idleTimer = null;
  }
}

function validateClock(clock: HostedDurabilityClock): void {
  if (
    typeof clock.now !== 'function'
    || typeof clock.setTimer !== 'function'
    || typeof clock.clearTimer !== 'function'
  ) {
    throw new TypeError('durability clock is invalid');
  }
}
