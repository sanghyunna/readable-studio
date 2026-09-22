import { useEffect, useRef, useState } from 'react';
import { listProjectRuns, RUNS_CHANGED_EVENT } from '../providers/daemon';
import { buildPetTaskCenter } from '../components/pet/taskCenter';
import type { PetTaskCenter } from '../components/pet/PetOverlay';
import type { Project } from '../types';

type PetTaskSource = {
  readonly enabled: boolean;
  readonly lowSpec: boolean;
  readonly projects: Project[];
};

export function usePetTaskCenter({ enabled, lowSpec, projects }: PetTaskSource): PetTaskCenter {
  const [tasks, setTasks] = useState<PetTaskCenter>({ running: [], queued: [], recent: [] });
  // Shared across effect generations so a profile/project change cannot overlap
  // an outstanding request from the previous subscription.
  const request = useRef<ReturnType<typeof listProjectRuns> | null>(null);
  useEffect(() => {
    if (!enabled) {
      setTasks({ running: [], queued: [], recent: [] });
      return;
    }
    let cancelled = false;
    let refreshing = false;
    let dirty = false;
    const refresh = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      if (refreshing) { dirty = true; return; }
      refreshing = true;
      try {
        do {
          dirty = false;
          const pending = request.current ?? listProjectRuns();
          request.current = pending;
          const runs = await pending;
          if (request.current === pending) request.current = null;
          if (cancelled) return;
          const next = buildPetTaskCenter(projects, runs);
          setTasks((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        } while (dirty && document.visibilityState === 'visible');
      } finally {
        refreshing = false;
      }
    };
    const onChange = () => { void refresh(); };
    window.addEventListener(RUNS_CHANGED_EVENT, onChange);
    document.addEventListener('visibilitychange', onChange);
    void refresh();
    // Local transitions refresh immediately. Both profiles also discover runs
    // changed by another client; low-spec uses a slower visible fallback.
    const timer = window.setInterval(onChange, lowSpec ? 15000 : 2000);
    return () => {
      cancelled = true;
      window.removeEventListener(RUNS_CHANGED_EVENT, onChange);
      document.removeEventListener('visibilitychange', onChange);
      window.clearInterval(timer);
    };
  }, [enabled, lowSpec, projects]);
  return tasks;
}
