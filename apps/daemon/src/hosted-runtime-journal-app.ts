import {
  type HostedDurableEventInput,
  type HostedEventChannel,
  type HostedEventJournalSnapshotV1,
  type HostedPreparedDurableEventBatch,
  type createHostedEventJournal,
} from './hosted-event-journal.js';

type JournalScope =
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'project'; readonly projectId: string };

export type HostedRuntimeJournalOperation =
  | {
      readonly kind: 'journal:mutate';
      readonly scope: JournalScope;
      readonly execute: () => Promise<{
        readonly events: readonly HostedDurableEventInput[];
        readonly value: unknown;
      }>;
    }
  | {
      readonly kind: 'journal:publish';
      readonly channel: HostedEventChannel;
      readonly event: string;
      readonly data: unknown;
    }
  | {
      readonly kind: 'journal:replay';
      readonly channel: HostedEventChannel;
      readonly after?: string | null;
    }
  | {
      readonly kind: 'journal:attach';
      readonly channel: HostedEventChannel;
      readonly after?: string | null;
      readonly response: Parameters<ReturnType<typeof createHostedEventJournal>['attach']>[0]['response'];
    }
  | { readonly kind: 'journal:close'; readonly channel: HostedEventChannel }
  | { readonly kind: 'journal:invalidate'; readonly channel: HostedEventChannel };

export interface HostedRuntimeJournalContext {
  readonly ownerKey: string;
  commitDurableEvents(batch: HostedPreparedDurableEventBatch, message: string): void;
  enqueueMutation<T>(execute: () => T | Promise<T>): Promise<T>;
  eventJournal(): ReturnType<typeof createHostedEventJournal>;
  ready(): Promise<void>;
  runtimeUnavailable(message: string): never;
  validateMutationEvents(
    scope: JournalScope,
    events: readonly HostedDurableEventInput[],
  ): void;
  validateMutationScope(scope: JournalScope): void;
  writeSnapshot(snapshot: HostedEventJournalSnapshotV1): void;
}

export async function executeHostedRuntimeJournalOperation(
  context: HostedRuntimeJournalContext,
  operation: HostedRuntimeJournalOperation,
): Promise<unknown> {
  switch (operation.kind) {
    case 'journal:mutate': {
      const pending: { value: HostedPreparedDurableEventBatch | null } = { value: null };
      try {
        const value = await context.enqueueMutation(async () => {
          context.validateMutationScope(operation.scope);
          const result = await operation.execute();
          context.validateMutationEvents(operation.scope, result.events);
          pending.value = context.eventJournal().prepareDurableBatch(result.events);
          context.writeSnapshot(pending.value.snapshot);
          return result.value;
        });
        if (pending.value == null) {
          context.runtimeUnavailable('hosted journal mutation was not prepared');
        }
        context.commitDurableEvents(
          pending.value,
          'hosted journal mutation publication failed',
        );
        return value;
      } catch (error) {
        pending.value?.rollback();
        throw error;
      }
    }
    case 'journal:publish':
      await context.ready();
      return context.eventJournal().publish(operation.channel, operation.event, operation.data);
    case 'journal:replay':
      await context.ready();
      return context.eventJournal().replay({
        ...(operation.after === undefined ? {} : { after: operation.after }),
        channel: operation.channel,
        ownerKey: context.ownerKey,
      });
    case 'journal:attach':
      await context.ready();
      return context.eventJournal().attach({
        ...(operation.after === undefined ? {} : { after: operation.after }),
        channel: operation.channel,
        ownerKey: context.ownerKey,
        response: operation.response,
      });
    case 'journal:close':
      await context.ready();
      context.eventJournal().close(operation.channel);
      return { ok: true };
    case 'journal:invalidate':
      await context.ready();
      context.eventJournal().invalidate(operation.channel);
      return { ok: true };
  }
}
