// Single entry point for web-side observability hooks.
//
// These observers still run defensively so local UI diagnostics and existing
// call sites remain intact, but their shared transport is a no-op in this fork:
// no exception, resource, boot-timing, or visibility data leaves the browser.

import { installLongTaskObserver } from './long-task';
import { installResourceErrorObserver } from './resource-error';
import { installBootTimingObserver } from './boot-timing';
import { installVisibilityObserver } from './visibility';
import { installWhiteScreenDetector } from './white-screen';

let installed = false;

export function installWebObservability(): () => void {
  if (installed) return () => undefined;
  if (typeof window === 'undefined') return () => undefined;
  installed = true;

  const teardowns: Array<() => void> = [
    installLongTaskObserver(),
    installResourceErrorObserver(),
    installBootTimingObserver(),
    installVisibilityObserver(),
    installWhiteScreenDetector(),
  ];

  return () => {
    for (const teardown of teardowns) {
      try {
        teardown();
      } catch {
        // best-effort — teardown failures must never propagate
      }
    }
    installed = false;
  };
}
