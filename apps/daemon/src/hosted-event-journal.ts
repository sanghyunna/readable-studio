import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export interface HostedEventLimits {
  heartbeatMs: number;
  maxBufferedBytes: number;
  maxBytes: number;
  maxConnections: number;
  maxEvents: number;
  slowClientMs: number;
}

export const HOSTED_EVENT_LIMITS: Readonly<HostedEventLimits> = Object.freeze({
  heartbeatMs: 25_000,
  maxBufferedBytes: 1024 * 1024,
  maxBytes: 8 * 1024 * 1024,
  maxConnections: 4,
  maxEvents: 2_000,
  slowClientMs: 5_000,
});

export const HOSTED_EVENT_GLOBAL_LIMITS = Object.freeze({
  maxBufferedBytes: 64 * 1024 * 1024,
  maxBytes: 256 * 1024 * 1024,
  maxConnections: 256,
  maxEvents: 128_000,
});

export type HostedEventChannel =
  | { kind: 'owner' }
  | { kind: 'project'; projectId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'run-ui'; runId: string };

export interface HostedEventRecord {
  at: number;
  cursor: string;
  data: unknown;
  event: string;
}

export type HostedEventResyncReason =
  | 'cursor-expired'
  | 'cursor-invalid'
  | 'generation-expired'
  | 'slow-client';

export type HostedEventReplayResult =
  | { kind: 'events'; events: HostedEventRecord[] }
  | { kind: 'not-owned' }
  | { kind: 'resync'; reason: Exclude<HostedEventResyncReason, 'slow-client'> };

export type HostedDurableEventMilestone =
  | 'resync'
  | 'run-created'
  | 'status-transition'
  | 'terminal';

export interface HostedEventJournalSnapshotV1 {
  readonly closedChannels: readonly HostedEventJournalSnapshotTombstone[];
  readonly events: readonly HostedEventJournalSnapshotEvent[];
  readonly evictedThrough: number;
  readonly generationTag: string;
  readonly invalidatedChannels: readonly HostedEventJournalSnapshotTombstone[];
  readonly nextSequence: number;
  readonly ownerTag: string;
  readonly schema: 'hosted-event-journal-v1';
}

export interface HostedEventJournalSnapshotEvent {
  readonly at: number;
  readonly channel: HostedEventChannel;
  readonly data: unknown;
  readonly event: string;
  readonly milestone: HostedDurableEventMilestone;
  readonly sequence: number;
}

export interface HostedEventJournalSnapshotTombstone {
  readonly channel: HostedEventChannel;
  readonly through: number;
}

export interface HostedPreparedDurableEvent {
  readonly record: HostedEventRecord;
  readonly snapshot: HostedEventJournalSnapshotV1;
  commit(): HostedEventRecord;
  rollback(): void;
}

export interface HostedDurableEventInput {
  readonly channel: HostedEventChannel;
  readonly data: unknown;
  readonly event: string;
  readonly milestone: HostedDurableEventMilestone;
}

export interface HostedPreparedDurableEventBatch {
  readonly records: readonly HostedEventRecord[];
  readonly snapshot: HostedEventJournalSnapshotV1;
  commit(): readonly HostedEventRecord[];
  rollback(): void;
}

export class HostedEventJournalError extends Error {
  constructor(
    readonly code: 'HOSTED_CAPACITY_EXHAUSTED' | 'HOSTED_OVERLOADED' | 'HOSTED_QUOTA_EXCEEDED',
    message: string,
  ) {
    super(message);
    this.name = 'HostedEventJournalError';
  }
}

export interface HostedEventBudget {
  adjustEvents(countDelta: number, bytesDelta: number): boolean;
  releaseBuffered(ownerKey: string, bytes: number): void;
  releaseConnection(ownerKey: string): void;
  reserveBuffered(ownerKey: string, bytes: number, ownerLimit: number): boolean;
  reserveConnection(ownerKey: string, ownerLimit: number): 'global-capacity' | 'owner-capacity' | 'reserved';
  reserveEvents(countDelta: number, bytesDelta: number): HostedEventBudgetReservation | null;
  snapshot(): { bufferedBytes: number; bytes: number; connections: number; events: number };
}

export interface HostedEventBudgetReservation {
  commit(): void;
  rollback(): void;
}

function boundedLimit(value: number | undefined, ceiling: number, name: string): number {
  if (value == null) return ceiling;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return Math.min(value, ceiling);
}

export function createHostedEventBudget(limits: {
  maxBufferedBytes?: number;
  maxBytes?: number;
  maxConnections?: number;
  maxEvents?: number;
} = {}): HostedEventBudget {
  const maximums = {
    maxBufferedBytes: boundedLimit(
      limits.maxBufferedBytes,
      HOSTED_EVENT_GLOBAL_LIMITS.maxBufferedBytes,
      'maxBufferedBytes',
    ),
    maxBytes: boundedLimit(limits.maxBytes, HOSTED_EVENT_GLOBAL_LIMITS.maxBytes, 'maxBytes'),
    maxConnections: boundedLimit(
      limits.maxConnections,
      HOSTED_EVENT_GLOBAL_LIMITS.maxConnections,
      'maxConnections',
    ),
    maxEvents: boundedLimit(limits.maxEvents, HOSTED_EVENT_GLOBAL_LIMITS.maxEvents, 'maxEvents'),
  };

  let events = 0;
  let bytes = 0;
  let reservedEventGrowth = 0;
  let reservedByteGrowth = 0;
  let connections = 0;
  let bufferedBytes = 0;
  const ownerConnections = new Map<string, number>();
  const ownerBufferedBytes = new Map<string, number>();

  const reserveEvents = (countDelta: number, bytesDelta: number): HostedEventBudgetReservation | null => {
    if (!Number.isSafeInteger(countDelta) || !Number.isSafeInteger(bytesDelta)) return null;
    const eventGrowth = Math.max(0, countDelta);
    const byteGrowth = Math.max(0, bytesDelta);
    if (
      events + countDelta < 0
      || bytes + bytesDelta < 0
      || events + reservedEventGrowth + eventGrowth > maximums.maxEvents
      || bytes + reservedByteGrowth + byteGrowth > maximums.maxBytes
    ) return null;
    reservedEventGrowth += eventGrowth;
    reservedByteGrowth += byteGrowth;
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      reservedEventGrowth -= eventGrowth;
      reservedByteGrowth -= byteGrowth;
    };
    return {
      commit() {
        if (!active) return;
        release();
        events += countDelta;
        bytes += bytesDelta;
      },
      rollback: release,
    };
  };

  return {
    adjustEvents(countDelta, bytesDelta) {
      const reservation = reserveEvents(countDelta, bytesDelta);
      if (reservation == null) return false;
      reservation.commit();
      return true;
    },
    reserveEvents,
    reserveConnection(ownerKey, ownerLimit) {
      const ownerCount = ownerConnections.get(ownerKey) ?? 0;
      if (ownerCount >= ownerLimit) return 'owner-capacity';
      if (connections >= maximums.maxConnections) return 'global-capacity';
      ownerConnections.set(ownerKey, ownerCount + 1);
      connections += 1;
      return 'reserved';
    },
    releaseConnection(ownerKey) {
      const ownerCount = ownerConnections.get(ownerKey) ?? 0;
      if (ownerCount <= 0) return;
      if (ownerCount === 1) ownerConnections.delete(ownerKey);
      else ownerConnections.set(ownerKey, ownerCount - 1);
      connections -= 1;
    },
    reserveBuffered(ownerKey, amount, ownerLimit) {
      const ownerBytes = ownerBufferedBytes.get(ownerKey) ?? 0;
      if (amount < 0 || ownerBytes + amount > ownerLimit || bufferedBytes + amount > maximums.maxBufferedBytes) {
        return false;
      }
      ownerBufferedBytes.set(ownerKey, ownerBytes + amount);
      bufferedBytes += amount;
      return true;
    },
    releaseBuffered(ownerKey, amount) {
      const ownerBytes = ownerBufferedBytes.get(ownerKey) ?? 0;
      const released = Math.min(ownerBytes, Math.max(0, amount));
      const nextOwnerBytes = ownerBytes - released;
      if (nextOwnerBytes === 0) ownerBufferedBytes.delete(ownerKey);
      else ownerBufferedBytes.set(ownerKey, nextOwnerBytes);
      bufferedBytes -= released;
    },
    snapshot() {
      return { bufferedBytes, bytes, connections, events };
    },
  };
}

interface StoredEvent extends HostedEventRecord {
  bytes: number;
  channel: HostedEventChannel;
  channelKey: string;
  dataJson: string;
  milestone: HostedDurableEventMilestone | null;
  sequence: number;
}

export interface HostedEventResponse {
  destroyed: boolean;
  writableLength?: number;
  writableEnded: boolean;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close' | 'drain' | 'finish', listener: () => void): this;
  off(event: 'close' | 'drain' | 'finish', listener: () => void): this;
}

export type HostedEventAttachResult =
  | { close(): void; kind: 'attached' }
  | { code: 'HOSTED_CAPACITY_EXHAUSTED' | 'HOSTED_OVERLOADED'; kind: 'overloaded' }
  | { kind: 'not-owned' }
  | { kind: 'resync'; reason: Exclude<HostedEventResyncReason, 'slow-client'> };

interface EventConnection {
  bufferedBytes: number;
  channelKey: string;
  closed: boolean;
  heartbeat: NodeJS.Timeout | null;
  onClose: () => void;
  onDrain: () => void;
  response: HostedEventResponse;
  slowClient: NodeJS.Timeout | null;
}

function channelKey(channel: HostedEventChannel): string {
  if (channel.kind === 'owner') return 'owner';
  const id = channel.kind === 'project' ? channel.projectId : channel.runId;
  if (id.length === 0 || id.length > 128 || /[\0\r\n]/u.test(id)) throw new Error('hosted event channel id is invalid');
  return `${channel.kind}:${id}`;
}

function channelFromSnapshot(value: unknown): HostedEventChannel {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hosted event journal snapshot channel is invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'owner' && Object.keys(record).length === 1) return { kind: 'owner' };
  const idKey = record.kind === 'project' ? 'projectId' : 'runId';
  if (
    (record.kind !== 'project' && record.kind !== 'run' && record.kind !== 'run-ui')
    || Object.keys(record).length !== 2
    || typeof record[idKey] !== 'string'
  ) {
    throw new Error('hosted event journal snapshot channel is invalid');
  }
  const id = record[idKey];
  if (
    path.posix.isAbsolute(id)
    || path.win32.isAbsolute(id)
    || /^file:/iu.test(id)
  ) {
    throw new Error('hosted event journal snapshot contains an absolute path');
  }
  const channel: HostedEventChannel = record.kind === 'project'
    ? { kind: 'project', projectId: id }
    : record.kind === 'run'
      ? { kind: 'run', runId: id }
      : { kind: 'run-ui', runId: id };
  channelKey(channel);
  return channel;
}

function channelFromKey(scope: string): HostedEventChannel {
  if (scope === 'owner') return { kind: 'owner' };
  for (const kind of ['project', 'run', 'run-ui'] as const) {
    const prefix = `${kind}:`;
    if (!scope.startsWith(prefix)) continue;
    const id = scope.slice(prefix.length);
    return channelFromSnapshot(kind === 'project'
      ? { kind, projectId: id }
      : { kind, runId: id });
  }
  throw new Error('hosted event journal snapshot channel is invalid');
}

function exactObject(value: unknown, keys: readonly string[], message: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(message);
  }
  return record;
}

function safeSnapshotData(value: unknown): unknown {
  const normalized = JSON.parse(safeJson(value)) as unknown;
  const stack: unknown[] = [normalized];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (
        path.posix.isAbsolute(current)
        || path.win32.isAbsolute(current)
        || /^file:/iu.test(current)
      ) {
        throw new Error('hosted event journal snapshot contains an absolute path');
      }
      continue;
    }
    if (current == null || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (/^(?:api[-_]?key|authorization|cookie|credentials?|password|private[-_]?key|provider[-_]?key|refresh[-_]?token|secret|access[-_]?token)$/iu.test(key)) {
        throw new Error('hosted event journal snapshot contains credential material');
      }
      stack.push(child);
    }
  }
  return normalized;
}

function isMilestone(value: unknown): value is HostedDurableEventMilestone {
  return value === 'resync'
    || value === 'run-created'
    || value === 'status-transition'
    || value === 'terminal';
}

function isSnapshotInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function ownerTag(ownerKey: string): string {
  return createHash('sha256').update(`hosted-event-owner-v1\0${ownerKey}`).digest('base64url');
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json == null) throw new Error('value is not JSON serializable');
    return json;
  } catch {
    throw new Error('hosted event data must be JSON serializable');
  }
}

export function createHostedEventJournal(options: {
  budget: HostedEventBudget;
  generation: string;
  limits?: Partial<HostedEventLimits>;
  ownerKey: string;
  restore?: HostedEventJournalSnapshotV1;
  secret?: Uint8Array;
}) {
  if (options.ownerKey.length === 0 || options.generation.length === 0) {
    throw new Error('hosted event owner and generation are required');
  }
  const limits: HostedEventLimits = {
    heartbeatMs: boundedLimit(options.limits?.heartbeatMs, HOSTED_EVENT_LIMITS.heartbeatMs, 'heartbeatMs'),
    maxBufferedBytes: boundedLimit(
      options.limits?.maxBufferedBytes,
      HOSTED_EVENT_LIMITS.maxBufferedBytes,
      'maxBufferedBytes',
    ),
    maxBytes: boundedLimit(options.limits?.maxBytes, HOSTED_EVENT_LIMITS.maxBytes, 'maxBytes'),
    maxConnections: boundedLimit(
      options.limits?.maxConnections,
      HOSTED_EVENT_LIMITS.maxConnections,
      'maxConnections',
    ),
    maxEvents: boundedLimit(options.limits?.maxEvents, HOSTED_EVENT_LIMITS.maxEvents, 'maxEvents'),
    slowClientMs: boundedLimit(options.limits?.slowClientMs, HOSTED_EVENT_LIMITS.slowClientMs, 'slowClientMs'),
  };

  const secret = Buffer.from(options.secret ?? randomBytes(32));
  const generationTag = createHash('sha256').update(options.generation).digest('base64url');
  const expectedOwnerTag = ownerTag(options.ownerKey);
  const events: StoredEvent[] = [];
  const connections = new Set<EventConnection>();
  const closedChannels = new Map<string, number>();
  const invalidatedThrough = new Map<string, number>();
  let eventBytes = 0;
  let evictedThrough = 0;
  let nextSequence = 1;
  let pending: { rollback(): void } | null = null;
  let disposed = false;

  const pruneTombstones = (
    retainedEvents: readonly StoredEvent[],
    retainedEvictedThrough: number,
    retainedClosedChannels: Map<string, number>,
    retainedInvalidatedThrough: Map<string, number>,
  ): void => {
    if (retainedClosedChannels.size === 0 && retainedInvalidatedThrough.size === 0) return;
    // Once a channel's protected history leaves the bounded event journal,
    // the global eviction cursor preserves cursor-expired semantics without
    // retaining that channel id forever.
    const earliestRetained = new Map<string, number>();
    for (const event of retainedEvents) {
      if (!earliestRetained.has(event.channelKey)) {
        earliestRetained.set(event.channelKey, event.sequence);
      }
    }

    for (const [scope, through] of retainedInvalidatedThrough) {
      if ((earliestRetained.get(scope) ?? Number.POSITIVE_INFINITY) > through) {
        retainedInvalidatedThrough.delete(scope);
      }
    }
    for (const [scope, lastSequence] of retainedClosedChannels) {
      if (
        lastSequence > 0
        && lastSequence <= retainedEvictedThrough
        && !earliestRetained.has(scope)
      ) {
        retainedClosedChannels.delete(scope);
      }
    }
    for (const scope of retainedClosedChannels.keys()) {
      if (retainedClosedChannels.size <= limits.maxEvents) break;
      if (!earliestRetained.has(scope)) retainedClosedChannels.delete(scope);
    }
  };

  const pruneChannelTombstones = (): void => {
    pruneTombstones(events, evictedThrough, closedChannels, invalidatedThrough);
  };

  const signCursor = (scope: string, sequence: number): string => createHmac('sha256', secret)
    .update(`${options.ownerKey}\0${scope}\0${generationTag}\0${sequence}`)
    .digest('base64url');

  const makeCursor = (scope: string, sequence: number): string => (
    `${generationTag}.${sequence.toString(36)}.${signCursor(scope, sequence)}`
  );

  const buildSnapshot = (
    retainedEvents: readonly StoredEvent[],
    retainedEvictedThrough: number,
    retainedNextSequence: number,
    retainedClosedChannels: ReadonlyMap<string, number>,
    retainedInvalidatedChannels: ReadonlyMap<string, number>,
  ): HostedEventJournalSnapshotV1 => {
    const snapshot: HostedEventJournalSnapshotV1 = {
      closedChannels: [...retainedClosedChannels]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([scope, through]) => ({ channel: channelFromKey(scope), through })),
      events: retainedEvents.flatMap((record) => record.milestone == null ? [] : [{
        at: record.at,
        channel: record.channel,
        data: safeSnapshotData(JSON.parse(record.dataJson) as unknown),
        event: record.event,
        milestone: record.milestone,
        sequence: record.sequence,
      }]),
      evictedThrough: retainedEvictedThrough,
      generationTag,
      invalidatedChannels: [...retainedInvalidatedChannels]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([scope, through]) => ({ channel: channelFromKey(scope), through })),
      nextSequence: retainedNextSequence,
      ownerTag: expectedOwnerTag,
      schema: 'hosted-event-journal-v1',
    };
    const encoded = safeJson(snapshot);
    if (Buffer.byteLength(encoded) > limits.maxBytes + limits.maxEvents * 1_024 + 64 * 1_024) {
      throw new HostedEventJournalError('HOSTED_QUOTA_EXCEEDED', 'hosted durable event snapshot is too large');
    }
    return JSON.parse(encoded) as HostedEventJournalSnapshotV1;
  };

  const restoreSnapshot = (input: HostedEventJournalSnapshotV1): void => {
    const snapshot = exactObject(input, [
      'closedChannels',
      'events',
      'evictedThrough',
      'generationTag',
      'invalidatedChannels',
      'nextSequence',
      'ownerTag',
      'schema',
    ], 'hosted event journal snapshot is invalid');
    if (
      snapshot.schema !== 'hosted-event-journal-v1'
      || snapshot.ownerTag !== expectedOwnerTag
      || typeof snapshot.generationTag !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/u.test(snapshot.generationTag)
      || snapshot.generationTag === generationTag
      || !isSnapshotInteger(snapshot.evictedThrough, 0)
      || !isSnapshotInteger(snapshot.nextSequence, 1)
      || snapshot.evictedThrough >= snapshot.nextSequence
      || !Array.isArray(snapshot.events)
      || snapshot.events.length > limits.maxEvents
      || !Array.isArray(snapshot.closedChannels)
      || snapshot.closedChannels.length > limits.maxEvents
      || !Array.isArray(snapshot.invalidatedChannels)
      || snapshot.invalidatedChannels.length > limits.maxEvents
    ) {
      throw new Error('hosted event journal snapshot is invalid');
    }
    if (Buffer.byteLength(safeJson(input)) > limits.maxBytes + limits.maxEvents * 1_024 + 64 * 1_024) {
      throw new HostedEventJournalError('HOSTED_QUOTA_EXCEEDED', 'hosted durable event snapshot is too large');
    }
    const restoredNextSequence = snapshot.nextSequence as number;
    const parsedEvents: StoredEvent[] = [];
    let priorSequence = 0;
    for (const value of snapshot.events) {
      const record = exactObject(value, [
        'at', 'channel', 'data', 'event', 'milestone', 'sequence',
      ], 'hosted event journal snapshot event is invalid');
      if (
        !isSnapshotInteger(record.at, 0)
        || typeof record.event !== 'string'
        || !/^[A-Za-z0-9_.-]{1,64}$/u.test(record.event)
        || !isMilestone(record.milestone)
        || !isSnapshotInteger(record.sequence, 1)
        || record.sequence <= priorSequence
        || record.sequence >= restoredNextSequence
      ) {
        throw new Error('hosted event journal snapshot event is invalid');
      }
      const channel = channelFromSnapshot(record.channel);
      const scope = channelKey(channel);
      const data = safeSnapshotData(record.data);
      const dataJson = safeJson(data);
      const cursor = makeCursor(scope, record.sequence);
      parsedEvents.push({
        at: record.at,
        bytes: Buffer.byteLength(`id: ${cursor}\nevent: ${record.event}\ndata: ${dataJson}\n\n`),
        channel,
        channelKey: scope,
        cursor,
        data,
        dataJson,
        event: record.event,
        milestone: record.milestone,
        sequence: record.sequence,
      });
      priorSequence = record.sequence;
    }

    const restoredBytes = parsedEvents.reduce((total, record) => total + record.bytes, 0);
    if (restoredBytes > limits.maxBytes) {
      throw new HostedEventJournalError('HOSTED_QUOTA_EXCEEDED', 'hosted durable event journal exceeds the byte limit');
    }

    const restoredClosedChannels = new Map<string, number>();
    const restoredInvalidatedChannels = new Map<string, number>();
    const restoreTombstones = (values: unknown[], target: Map<string, number>): void => {
      for (const value of values) {
        const tombstone = exactObject(value, ['channel', 'through'], 'hosted event journal snapshot tombstone is invalid');
        if (!isSnapshotInteger(tombstone.through, 0) || tombstone.through >= restoredNextSequence) {
          throw new Error('hosted event journal snapshot tombstone is invalid');
        }
        const scope = channelKey(channelFromSnapshot(tombstone.channel));
        if (target.has(scope)) throw new Error('hosted event journal snapshot tombstone is duplicated');
        target.set(scope, tombstone.through);
      }
    };
    restoreTombstones(snapshot.closedChannels, restoredClosedChannels);
    restoreTombstones(snapshot.invalidatedChannels, restoredInvalidatedChannels);

    if (!options.budget.adjustEvents(parsedEvents.length, restoredBytes)) {
      throw new HostedEventJournalError('HOSTED_CAPACITY_EXHAUSTED', 'hosted event journal global capacity is exhausted');
    }
    events.push(...parsedEvents);
    eventBytes = restoredBytes;
    evictedThrough = snapshot.evictedThrough;
    nextSequence = restoredNextSequence;
    for (const [scope, through] of restoredClosedChannels) closedChannels.set(scope, through);
    for (const [scope, through] of restoredInvalidatedChannels) invalidatedThrough.set(scope, through);
    pruneChannelTombstones();
  };

  const parseCursor = (
    scope: string,
    cursor: string,
  ): { kind: 'ok'; sequence: number } | { kind: 'resync'; reason: Exclude<HostedEventResyncReason, 'slow-client'> } => {
    const parts = cursor.split('.');
    if (parts.length !== 3) return { kind: 'resync', reason: 'cursor-invalid' };
    if (parts[0] !== generationTag) return { kind: 'resync', reason: 'generation-expired' };
    if (!/^[0-9a-z]+$/u.test(parts[1]!)) return { kind: 'resync', reason: 'cursor-invalid' };
    const sequence = Number.parseInt(parts[1]!, 36);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= nextSequence) {
      return { kind: 'resync', reason: 'cursor-invalid' };
    }
    const expected = Buffer.from(signCursor(scope, sequence));
    const actual = Buffer.from(parts[2]!);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { kind: 'resync', reason: 'cursor-invalid' };
    }
    if (sequence <= Math.max(evictedThrough, invalidatedThrough.get(scope) ?? 0)) {
      return { kind: 'resync', reason: 'cursor-expired' };
    }
    return { kind: 'ok', sequence };
  };

  const replay = (input: {
    after?: string | null;
    channel: HostedEventChannel;
    ownerKey: string;
  }): HostedEventReplayResult => {
    if (input.ownerKey !== options.ownerKey) return { kind: 'not-owned' };
    if (disposed) return { kind: 'resync', reason: 'generation-expired' };
    const scope = channelKey(input.channel);
    let afterSequence = 0;
    if (input.after != null && input.after.length > 0) {
      const parsed = parseCursor(scope, input.after);
      if (parsed.kind === 'resync') return parsed;
      afterSequence = parsed.sequence;
    }
    afterSequence = Math.max(afterSequence, invalidatedThrough.get(scope) ?? 0);
    return {
      kind: 'events',
      events: events
        .filter((event) => event.channelKey === scope && event.sequence > afterSequence)
        .map(({ at, cursor, dataJson, event }) => ({
          at,
          cursor,
          data: JSON.parse(dataJson) as unknown,
          event,
        })),
    };
  };

  const frameForEvent = (record: Pick<StoredEvent, 'cursor' | 'dataJson' | 'event'>): string => (
    `id: ${record.cursor}\nevent: ${record.event}\ndata: ${record.dataJson}\n\n`
  );

  const createStoredEvent = (
    channel: HostedEventChannel,
    event: string,
    data: unknown,
    milestone: HostedDurableEventMilestone | null,
    sequence = nextSequence,
  ): StoredEvent => {
    if (disposed) throw new Error('hosted event journal is disposed');
    if (pending != null) throw new Error('hosted durable event is awaiting commit');
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(event)) throw new Error('hosted event name is invalid');
    const scope = channelKey(channel);
    const normalizedData = milestone == null ? JSON.parse(safeJson(data)) as unknown : safeSnapshotData(data);
    if (milestone === 'resync') {
      const resync = normalizedData as { reason?: unknown };
      if (
        event !== 'resync'
        || resync == null
        || typeof resync !== 'object'
        || !['cursor-expired', 'cursor-invalid', 'generation-expired'].includes(String(resync.reason))
      ) {
        throw new Error('hosted durable resync event is invalid');
      }
    }
    const dataJson = safeJson(normalizedData);
    const cursor = makeCursor(scope, sequence);
    const bytes = Buffer.byteLength(`id: ${cursor}\nevent: ${event}\ndata: ${dataJson}\n\n`);
    if (bytes > limits.maxBytes) {
      throw new HostedEventJournalError('HOSTED_QUOTA_EXCEEDED', 'hosted event exceeds the per-user journal byte limit');
    }
    return {
      at: Date.now(),
      bytes,
      channel: channelFromSnapshot(channel),
      channelKey: scope,
      cursor,
      data: normalizedData,
      dataJson,
      event,
      milestone,
      sequence,
    };
  };

  const retentionFor = (records: readonly StoredEvent[]): {
    readonly evictedThrough: number;
    readonly removeBytes: number;
    readonly removeCount: number;
    readonly retained: StoredEvent[];
  } => {
    const candidates = [...events, ...records];
    const candidateBytes = records.reduce((total, record) => total + record.bytes, eventBytes);
    let removeCount = 0;
    let removeBytes = 0;
    while (
      candidates.length - removeCount > limits.maxEvents
      || candidateBytes - removeBytes > limits.maxBytes
    ) {
      const removed = candidates[removeCount];
      if (removed == null) break;
      removeCount += 1;
      removeBytes += removed.bytes;
    }
    return {
      evictedThrough: removeCount === 0
        ? evictedThrough
        : Math.max(evictedThrough, candidates[removeCount - 1]!.sequence),
      removeBytes,
      removeCount,
      retained: candidates.slice(removeCount),
    };
  };

  const closeConnections = (scope: string): void => {
    for (const connection of [...connections]) {
      if (connection.channelKey !== scope) continue;
      const response = connection.response;
      detach(connection);
      if (!response.destroyed && !response.writableEnded) {
        try { response.end(); } catch { /* The peer has already gone away. */ }
      }
    }
  };

  const writeResync = (response: HostedEventResponse, reason: HostedEventResyncReason): void => {
    if (response.destroyed || response.writableEnded) return;
    try {
      response.write(`event: resync\ndata: ${JSON.stringify({ reason })}\n\n`);
      response.end();
    } catch {
      // The peer has already gone away.
    }
  };

  const detach = (connection: EventConnection): void => {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.heartbeat != null) clearTimeout(connection.heartbeat);
    if (connection.slowClient != null) clearTimeout(connection.slowClient);
    connection.heartbeat = null;
    connection.slowClient = null;
    connection.response.off('close', connection.onClose);
    connection.response.off('finish', connection.onClose);
    connection.response.off('drain', connection.onDrain);
    connections.delete(connection);
    options.budget.releaseBuffered(options.ownerKey, connection.bufferedBytes);
    options.budget.releaseConnection(options.ownerKey);
    connection.bufferedBytes = 0;
  };

  const closeSlowClient = (connection: EventConnection): void => {
    if (connection.closed) return;
    const response = connection.response;
    detach(connection);
    writeResync(response, 'slow-client');
  };

  const scheduleHeartbeat = (connection: EventConnection): void => {
    if (connection.closed) return;
    if (connection.heartbeat != null) clearTimeout(connection.heartbeat);
    connection.heartbeat = setTimeout(() => {
      connection.heartbeat = null;
      writeToConnection(connection, ': keepalive\n\n');
    }, limits.heartbeatMs);
    connection.heartbeat.unref?.();
  };

  const writeToConnection = (connection: EventConnection, frame: string): boolean => {
    if (connection.closed || connection.response.destroyed || connection.response.writableEnded) {
      detach(connection);
      return false;
    }
    let writable: boolean;
    try {
      writable = connection.response.write(frame);
    } catch {
      detach(connection);
      return false;
    }
    scheduleHeartbeat(connection);
    if (writable) return true;

    const frameBytes = Buffer.byteLength(frame);
    const bytes = connection.response.writableLength == null
      ? frameBytes
      : Math.max(0, connection.response.writableLength - connection.bufferedBytes);
    if (bytes <= 0) return true;
    if (!options.budget.reserveBuffered(options.ownerKey, bytes, limits.maxBufferedBytes)) {
      closeSlowClient(connection);
      return false;
    }
    connection.bufferedBytes += bytes;
    if (connection.slowClient == null) {
      connection.slowClient = setTimeout(() => closeSlowClient(connection), limits.slowClientMs);
      connection.slowClient.unref?.();
    }
    return true;
  };

  const attach = (input: {
    after?: string | null;
    channel: HostedEventChannel;
    ownerKey: string;
    response: HostedEventResponse;
  }): HostedEventAttachResult => {
    const replayResult = replay(input);
    if (replayResult.kind !== 'events') {
      if (replayResult.kind === 'resync') writeResync(input.response, replayResult.reason);
      return replayResult;
    }
    if (input.response.destroyed || input.response.writableEnded) {
      return { close() {}, kind: 'attached' };
    }
    const reservation = options.budget.reserveConnection(options.ownerKey, limits.maxConnections);
    if (reservation !== 'reserved') {
      return {
        code: reservation === 'owner-capacity' ? 'HOSTED_OVERLOADED' : 'HOSTED_CAPACITY_EXHAUSTED',
        kind: 'overloaded',
      };
    }

    const scope = channelKey(input.channel);
    const connection: EventConnection = {
      bufferedBytes: 0,
      channelKey: scope,
      closed: false,
      heartbeat: null,
      onClose: () => detach(connection),
      onDrain: () => {
        options.budget.releaseBuffered(options.ownerKey, connection.bufferedBytes);
        connection.bufferedBytes = 0;
        if (connection.slowClient != null) clearTimeout(connection.slowClient);
        connection.slowClient = null;
      },
      response: input.response,
      slowClient: null,
    };
    connections.add(connection);
    input.response.on('close', connection.onClose);
    input.response.on('finish', connection.onClose);
    input.response.on('drain', connection.onDrain);
    scheduleHeartbeat(connection);
    const replayCursors = new Set(replayResult.events.map((event) => event.cursor));
    for (const record of events) {
      if (
        connection.closed ||
        record.channelKey !== scope ||
        !replayCursors.has(record.cursor)
      ) continue;
      writeToConnection(connection, frameForEvent(record));
    }
    if (closedChannels.has(scope)) {
      detach(connection);
      if (!input.response.destroyed && !input.response.writableEnded) input.response.end();
    }
    return {
      close: () => {
        const response = connection.response;
        detach(connection);
        if (!response.destroyed && !response.writableEnded) {
          try { response.end(); } catch { /* The peer has already gone away. */ }
        }
      },
      kind: 'attached',
    };
  };

  if (options.restore != null) restoreSnapshot(options.restore);

  const prepareDurableBatch = (
    input: readonly HostedDurableEventInput[],
  ): HostedPreparedDurableEventBatch => {
    if (input.length === 0) throw new Error('hosted durable event batch is empty');
    const records = input.map(({ channel, data, event, milestone }, index) => {
      if (!isMilestone(milestone)) throw new Error('hosted durable event milestone is invalid');
      return createStoredEvent(channel, event, data, milestone, nextSequence + index);
    });
    if (
      records.length > limits.maxEvents
      || records.reduce((total, record) => total + record.bytes, 0) > limits.maxBytes
    ) {
      throw new HostedEventJournalError('HOSTED_QUOTA_EXCEEDED', 'hosted durable event batch exceeds the journal limit');
    }
    const retention = retentionFor(records);
    const retainedBytes = retention.retained.reduce((total, record) => total + record.bytes, 0);
    const reservation = options.budget.reserveEvents(
      retention.retained.length - events.length,
      retainedBytes - eventBytes,
    );
    if (reservation == null) {
      throw new HostedEventJournalError('HOSTED_CAPACITY_EXHAUSTED', 'hosted event journal global capacity is exhausted');
    }
    const candidateClosed = new Map(closedChannels);
    const candidateInvalidated = new Map(invalidatedThrough);
    for (const record of records) {
      if (record.milestone === 'terminal') {
        candidateClosed.delete(record.channelKey);
        candidateClosed.set(record.channelKey, record.sequence);
      } else if (record.milestone === 'resync') {
        candidateInvalidated.delete(record.channelKey);
        candidateInvalidated.set(record.channelKey, record.sequence);
      }
    }
    pruneTombstones(
      retention.retained,
      retention.evictedThrough,
      candidateClosed,
      candidateInvalidated,
    );

    let state: 'committed' | 'pending' | 'rolled-back' = 'pending';
    const rollback = (): void => {
      if (state !== 'pending') return;
      state = 'rolled-back';
      reservation.rollback();
      pending = null;
    };
    try {
      const snapshot = buildSnapshot(
        retention.retained,
        retention.evictedThrough,
        nextSequence + records.length,
        candidateClosed,
        candidateInvalidated,
      );
      const publicRecords = records.map(({ at, cursor, dataJson, event }) => ({
        at,
        cursor,
        data: JSON.parse(dataJson) as unknown,
        event,
      }));
      const prepared: HostedPreparedDurableEventBatch = {
        records: publicRecords,
        snapshot,
        commit(): readonly HostedEventRecord[] {
          if (state === 'committed') return prepared.records;
          if (state !== 'pending' || disposed || pending?.rollback !== rollback) {
            throw new Error('hosted durable event is no longer pending');
          }
          state = 'committed';
          pending = null;
          reservation.commit();
          events.splice(0, events.length, ...retention.retained);
          eventBytes = retainedBytes;
          evictedThrough = retention.evictedThrough;
          nextSequence += records.length;
          closedChannels.clear();
          for (const [scope, through] of candidateClosed) closedChannels.set(scope, through);
          invalidatedThrough.clear();
          for (const [scope, through] of candidateInvalidated) invalidatedThrough.set(scope, through);
          const closingScopes = new Set<string>();
          for (const record of records) {
            for (const connection of connections) {
              if (connection.channelKey === record.channelKey) {
                writeToConnection(connection, frameForEvent(record));
              }
            }
            if (record.milestone === 'terminal' || record.milestone === 'resync') {
              closingScopes.add(record.channelKey);
            }
          }
          for (const scope of closingScopes) closeConnections(scope);
          return prepared.records;
        },
        rollback,
      };
      pending = { rollback };
      return prepared;
    } catch (error) {
      reservation.rollback();
      throw error;
    }
  };

  return {
    prepareDurableBatch,
    prepareDurable(
      channel: HostedEventChannel,
      event: string,
      data: unknown,
      milestone: HostedDurableEventMilestone,
    ): HostedPreparedDurableEvent {
      const batch = prepareDurableBatch([{ channel, data, event, milestone }]);
      const record = batch.records[0]!;
      return {
        record,
        snapshot: batch.snapshot,
        commit() {
          batch.commit();
          return record;
        },
        rollback: batch.rollback,
      };
    },
    publish(channel: HostedEventChannel, event: string, data: unknown): HostedEventRecord {
      const record = createStoredEvent(channel, event, data, null);
      const retention = retentionFor([record]);
      if (!options.budget.adjustEvents(
        1 - retention.removeCount,
        record.bytes - retention.removeBytes,
      )) {
        throw new HostedEventJournalError('HOSTED_CAPACITY_EXHAUSTED', 'hosted event journal global capacity is exhausted');
      }
      if (retention.removeCount > 0) events.splice(0, retention.removeCount);

      nextSequence += 1;
      events.push(record);
      eventBytes = eventBytes - retention.removeBytes + record.bytes;
      evictedThrough = retention.evictedThrough;
      pruneChannelTombstones();
      for (const connection of connections) {
        if (connection.channelKey === record.channelKey) writeToConnection(connection, frameForEvent(record));
      }
      return {
        at: record.at,
        cursor: record.cursor,
        data: JSON.parse(record.dataJson) as unknown,
        event: record.event,
      };
    },
    close(channel: HostedEventChannel): void {
      if (pending != null) throw new Error('hosted durable event is awaiting commit');
      const scope = channelKey(channel);
      let lastSequence = evictedThrough;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!;
        if (event.channelKey !== scope) continue;
        lastSequence = event.sequence;
        break;
      }
      closedChannels.delete(scope);
      closedChannels.set(scope, lastSequence);
      pruneChannelTombstones();
      closeConnections(scope);
    },
    invalidate(channel: HostedEventChannel): void {
      if (pending != null) throw new Error('hosted durable event is awaiting commit');
      const scope = channelKey(channel);
      invalidatedThrough.delete(scope);
      invalidatedThrough.set(scope, nextSequence - 1);
      pruneChannelTombstones();
      for (const connection of [...connections]) {
        if (connection.channelKey !== scope) continue;
        const response = connection.response;
        detach(connection);
        writeResync(response, 'cursor-expired');
      }
    },
    attach,
    replay,
    dispose(): void {
      if (disposed) return;
      pending?.rollback();
      pending = null;
      disposed = true;
      for (const connection of [...connections]) {
        const response = connection.response;
        detach(connection);
        if (!response.destroyed && !response.writableEnded) {
          try { response.end(); } catch { /* Continue releasing the remaining journal resources. */ }
        }
      }
      options.budget.adjustEvents(-events.length, -eventBytes);
      events.length = 0;
      eventBytes = 0;
      closedChannels.clear();
      invalidatedThrough.clear();
    },
  };
}
