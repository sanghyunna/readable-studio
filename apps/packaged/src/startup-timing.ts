export const PACKAGED_STARTUP_PHASE_EVENT = "packaged startup phase";

export type PackagedStartupPhaseLogger = (phase: string) => void;

type StartupPhaseEvent = {
  elapsedMs: number;
  phase: string;
  uptimeMs: number;
};

export type PackagedStartupPhaseTimer = {
  flush(): void;
  mark: PackagedStartupPhaseLogger;
};

export function createPackagedStartupPhaseTimer(
  options: { buffer?: boolean } = {},
): PackagedStartupPhaseTimer {
  const startedAt = Date.now();
  let buffering = options.buffer === true;
  const pending: StartupPhaseEvent[] = [];

  const createEvent = (phase: string): StartupPhaseEvent => ({
    elapsedMs: Date.now() - startedAt,
    phase,
    uptimeMs: Math.round(process.uptime() * 1000),
  });

  const emit = (event: StartupPhaseEvent): void => {
    console.info(PACKAGED_STARTUP_PHASE_EVENT, event);
  };

  const mark: PackagedStartupPhaseLogger = (phase) => {
    const event = createEvent(phase);
    if (buffering) {
      pending.push(event);
      return;
    }
    emit(event);
  };

  return {
    flush() {
      buffering = false;
      for (const event of pending.splice(0)) {
        emit(event);
      }
    },
    mark,
  };
}
