import type {
  HostedEventAttachResult,
  HostedEventChannel,
  HostedEventResponse,
} from './hosted-event-journal.js';

export const HOSTED_LAST_EVENT_ID_MAX_BYTES = 256;

export interface HostedSseResponse extends HostedEventResponse {
  flushHeaders(): void;
  removeHeader(name: string): void;
  setHeader(name: string, value: string): void;
}

interface HostedSseJournal {
  attach(input: {
    after?: string | null;
    channel: HostedEventChannel;
    ownerKey: string;
    response: HostedEventResponse;
  }): HostedEventAttachResult;
}

export interface HostedSseWeakLease {
  readonly generation: number;
  readonly journal: HostedSseJournal;
  readonly ownerKey: string;
  release(): void;
}

export type AcquireHostedSseWeakLease = (binding: {
  channel: HostedEventChannel;
  generation: number;
  ownerKey: string;
}) => HostedSseWeakLease | null;

export type HostedSseOpenResult =
  | HostedEventAttachResult
  | { code: 'BAD_REQUEST'; kind: 'bad-request'; message: string }
  | { code: 'HOSTED_RUNTIME_UNAVAILABLE'; kind: 'unavailable' };

function badRequest(message: string): HostedSseOpenResult {
  return { code: 'BAD_REQUEST', kind: 'bad-request', message };
}

function validBindingPart(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\0\r\n]/u.test(value);
}

function readLastEventId(value: string | string[] | null | undefined):
  | { kind: 'ok'; value: string | null }
  | { kind: 'bad-request'; result: HostedSseOpenResult } {
  if (value == null) return { kind: 'ok', value: null };
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > HOSTED_LAST_EVENT_ID_MAX_BYTES ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    return { kind: 'bad-request', result: badRequest('Last-Event-ID is invalid') };
  }
  return { kind: 'ok', value };
}

function setSseHeaders(response: HostedSseResponse): void {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
}

function clearSseHeaders(response: HostedSseResponse): void {
  for (const name of ['Content-Type', 'Cache-Control', 'Connection', 'X-Accel-Buffering']) {
    response.removeHeader(name);
  }
}

export function createHostedSseAdapter(options: {
  acquireWeak: AcquireHostedSseWeakLease;
}) {
  const open = (input: {
    channel: HostedEventChannel;
    generation: number;
    lastEventId?: string | string[] | null;
    ownerKey: string;
    response: HostedSseResponse;
  }): HostedSseOpenResult => {
    if (!validBindingPart(input.ownerKey) || !Number.isSafeInteger(input.generation) || input.generation <= 0) {
      return badRequest('hosted SSE binding is invalid');
    }
    const lastEventId = readLastEventId(input.lastEventId);
    if (lastEventId.kind === 'bad-request') return lastEventId.result;

    const lease = options.acquireWeak({
      channel: input.channel,
      generation: input.generation,
      ownerKey: input.ownerKey,
    });
    if (lease == null) return { code: 'HOSTED_RUNTIME_UNAVAILABLE', kind: 'unavailable' };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lease.release();
    };
    if (lease.ownerKey !== input.ownerKey || lease.generation !== input.generation) {
      release();
      return { code: 'HOSTED_RUNTIME_UNAVAILABLE', kind: 'unavailable' };
    }

    let attached: HostedEventAttachResult;
    try {
      setSseHeaders(input.response);
      attached = lease.journal.attach({
        after: lastEventId.value,
        channel: input.channel,
        ownerKey: input.ownerKey,
        response: input.response,
      });
    } catch (error) {
      release();
      throw error;
    }
    if (attached.kind !== 'attached') {
      release();
      if (attached.kind !== 'resync') clearSseHeaders(input.response);
      return attached;
    }
    if (input.response.destroyed || input.response.writableEnded) {
      attached.close();
      release();
      return attached;
    }

    const onDone = () => {
      input.response.off('close', onDone);
      input.response.off('finish', onDone);
      release();
    };
    try {
      input.response.on('close', onDone);
      input.response.on('finish', onDone);
      input.response.flushHeaders();
    } catch (error) {
      input.response.off('close', onDone);
      input.response.off('finish', onDone);
      attached.close();
      release();
      throw error;
    }
    return {
      close() {
        input.response.off('close', onDone);
        input.response.off('finish', onDone);
        attached.close();
        release();
      },
      kind: 'attached',
    };
  };

  return {
    openProjectStream(input: {
      generation: number;
      lastEventId?: string | string[] | null;
      ownerKey: string;
      projectId: string;
      response: HostedSseResponse;
    }): HostedSseOpenResult {
      if (!validBindingPart(input.projectId)) return badRequest('project id is invalid');
      return open({ ...input, channel: { kind: 'project', projectId: input.projectId } });
    },
    openRunStream(input: {
      generation: number;
      lastEventId?: string | string[] | null;
      ownerKey: string;
      response: HostedSseResponse;
      runId: string;
    }): HostedSseOpenResult {
      if (!validBindingPart(input.runId)) return badRequest('run id is invalid');
      return open({ ...input, channel: { kind: 'run', runId: input.runId } });
    },
  };
}
