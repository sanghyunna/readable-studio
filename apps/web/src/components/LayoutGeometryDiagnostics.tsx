import { useEffect } from 'react';

const EVENT = 'readable:layout-geometry';
const REASONS = ['resize', 'maximize', 'unmaximize', 'restore', 'display-metrics-changed', 'question-mounted', 'question-answered'] as const;
type GeometryReason = typeof REASONS[number];

export function requestLayoutGeometry(reason: GeometryReason): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: reason }));
}

/** Samples only geometry; console capture persists these lines in desktop renderer.log. */
export function LayoutGeometryDiagnostics() {
  useEffect(() => {
    const reasons = new Set<GeometryReason>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = '';
    const sample = () => {
      timer = undefined;
      const shell = document.querySelector<HTMLElement>('.workspace-shell');
      if (!shell) { reasons.clear(); return; }
      const rect = shell.getBoundingClientRect();
      const geometry = {
        source: 'renderer', reasons: [...reasons].sort(),
        innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio,
        clientHeight: document.documentElement.clientHeight,
        shell: { top: rect.top, height: rect.height, scrollTop: shell.scrollTop },
        rootScrollTop: document.documentElement.scrollTop, bodyScrollTop: document.body.scrollTop,
      };
      reasons.clear();
      const key = JSON.stringify(geometry);
      if (key === previous) return;
      previous = key;
      // Stringify here: Chromium's console-message bridge would flatten an object to [object Object].
      console.info(`layout geometry ${key}`);
    };
    const queue = (reason: GeometryReason) => {
      reasons.add(reason);
      timer ??= setTimeout(sample, 250);
    };
    const resize = () => queue('resize');
    const event = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      // The preload bridge carries only allowlisted event names, never arbitrary payloads.
      for (const reason of REASONS) if (event.detail === reason) queue(reason);
    };
    window.addEventListener('resize', resize);
    window.addEventListener(EVENT, event);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('resize', resize);
      window.removeEventListener(EVENT, event);
    };
  }, []);
  return null;
}
