import type { Express, RequestHandler } from 'express';
import { readAppConfig } from '../app-config.js';
import { detectAgents, getStartupScanProgress } from '../runtimes/detection.js';

/** The splash may reach the daemon before the web app has mounted. */
export function registerAgentScanRoute(app: Express, dataDir: string, requireLocalDaemonRequest: RequestHandler): void {
  let startup: Promise<void> | undefined;
  let failure: { readonly error: unknown } | undefined;
  const ensureStartupScan = (): Promise<void> => {
    if (getStartupScanProgress() !== null) return Promise.resolve();
    // Retain this latch after completion: polls must not revalidate storage or
    // start new sessions. Web discovery still joins detection's shared run.
    return startup ??= readAppConfig(dataDir).then((config) => {
      void detectAgents(config.agentCliEnv).catch((error: unknown) => {
        failure = { error };
        console.warn('startup agent scan failed', { errorType: error instanceof Error ? error.name : 'unknown' });
      });
    });
  };

  app.post('/api/agents/scan', requireLocalDaemonRequest, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await ensureStartupScan();
      if (failure && getStartupScanProgress() === null) throw failure.error;
      res.json({ scan: getStartupScanProgress() });
    } catch (error: unknown) {
      // HTTP boundary: initialization errors remain visible to the caller.
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/agents/scan', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (failure && getStartupScanProgress() === null) {
      res.status(500).json({ error: failure.error instanceof Error ? failure.error.message : String(failure.error) });
      return;
    }
    res.json({ scan: getStartupScanProgress() });
  });
}
