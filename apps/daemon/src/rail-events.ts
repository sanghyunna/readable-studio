import { EventEmitter } from 'node:events';
import type { RailSseEvent } from '@readable-studio/contracts';

export type RailChangeReason = RailSseEvent['reason'];

/**
 * In-process fan-out for `GET /api/rail/events`. Every rail mutation (session
 * create/rename/move/delete, folder create/rename/delete) emits one event so
 * open rails refetch `GET /api/rail`.
 */
class RailEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(reason: RailChangeReason, ids: string[]): void {
    const event: RailSseEvent = { type: 'rail-changed', reason, ids, at: Date.now() };
    this.emitter.emit('rail-changed', event);
  }

  subscribe(listener: (event: RailSseEvent) => void): () => void {
    this.emitter.on('rail-changed', listener);
    return () => {
      this.emitter.off('rail-changed', listener);
    };
  }
}

export const railEvents = new RailEventBus();
