import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  DatabricksScanEvent, DatabricksScanRequest, DatabricksScanResponse,
  DatabricksSetupRequest, DatabricksSetupResponse, DatabricksStatusResponse,
} from '@readable-studio/contracts';
import { registerDatabricksRoutes } from '../../apps/daemon/src/databricks-routes.js';
import { createDatabricksService } from '../../apps/daemon/src/databricks/service.js';
import { listenOnFetchCompatiblePort } from '../../apps/daemon/src/fetch-compatible-listener.js';

// Resolve the owning app's HTTP framework without adding a second Express dependency.
const require = createRequire(new URL('../../apps/daemon/package.json', import.meta.url));
const express = require('express') as {
  (): Parameters<typeof registerDatabricksRoutes>[0];
  json(): Parameters<typeof registerDatabricksRoutes>[1]['http']['requireLocalDaemonRequest'];
};

// Like localized-content.test.ts, load the shipped web module through Vite rather
// than pulling its bundler-only module graph into the e2e NodeNext compilation.
// The consumer signatures come from shared DTOs; runtime assertions below check
// the actual JSON, not merely a TypeScript cast or a fabricated setup response.
type DatabricksClient = {
  fetchDatabricksStatus(): Promise<DatabricksStatusResponse>;
  setupDatabricks(request: DatabricksSetupRequest): Promise<DatabricksSetupResponse>;
  startDatabricksScan(request: DatabricksScanRequest): Promise<DatabricksScanResponse>;
  streamDatabricksScanEvents(scanId: string, handlers: {
    onEvent(event: DatabricksScanEvent): void;
  }, options: { signal: AbortSignal }): Promise<boolean>;
};
const clientModules = import.meta.glob<DatabricksClient>(
  '../../apps/web/src/providers/databricks.ts', { eager: true },
);
const client = Object.values(clientModules)[0];
if (!client) throw new Error('Databricks web client module was not loaded');

const TEST_TOKEN = 'test-token-not-a-real-credential';

async function bounded<T>(signal: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([signal, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Expected Databricks event was not received')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

describe('Databricks setup contract seam', () => {
  it('[P1] returns a validated profile the real web client can immediately scan', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'databricks-setup-e2e-'));
    const nativeFetch = globalThis.fetch;
    let scanSubscribed!: () => void;
    const subscribed = new Promise<void>((resolve) => { scanSubscribed = resolve; });
    const workspaceFetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(new URL(url).origin).toBe('https://workspace.example');
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${TEST_TOKEN}` });
      switch (new URL(url).pathname) {
        case '/api/2.0/preview/scim/v2/Me': return Response.json({ id: 'test-user' });
        case '/api/2.0/serving-endpoints':
          await bounded(subscribed);
          return Response.json({ endpoints: [] });
        case '/api/2.1/unity-catalog/catalogs':
          await bounded(subscribed);
          return Response.json({ catalogs: [] });
        default: throw new Error(`Unexpected workspace request: ${url}`);
      }
    });
    const service = createDatabricksService({
      dataRoot, clientOptions: { resolveExecutable: async () => null }, fetch: workspaceFetch,
    });
    const setup = vi.spyOn(service, 'setup');
    const startScan = vi.spyOn(service, 'startScan');
    const subscribeScan = service.subscribeScan.bind(service);
    vi.spyOn(service, 'subscribeScan').mockImplementation(async (scanId, listener) => {
      const unsubscribe = await subscribeScan(scanId, listener);
      // Subscription is installed before the upstream scan can complete.
      scanSubscribed();
      return unsubscribe;
    });
    const app = express();
    app.use(express.json());
    registerDatabricksRoutes(app, {
      service,
      setClient: async () => { throw new Error('Setup must not select a CLI executable'); },
      // Bootstrap authorization is outside this route/contract seam.
      http: { requireLocalDaemonRequest: (_req, _res, next) => next() },
    });
    const server = createServer(app);
    let scanId: string | undefined;
    try {
      const { port } = await bounded(listenOnFetchCompatiblePort(server));
      const url = `http://127.0.0.1:${port}`;
      // Only supply the browser's relative-URL origin. Every request/response
      // still traverses the real client, TCP listener, routes and service.
      vi.stubGlobal('fetch', (input: string, init?: RequestInit) => nativeFetch(new URL(input, url), {
        ...init, signal: init?.signal ?? AbortSignal.timeout(5000),
      }));

      expect(await client.fetchDatabricksStatus()).toMatchObject({
        cli: 'missing', setupRequired: true, profiles: [],
      });
      const request: DatabricksSetupRequest = {
        mode: 'workspace-token', host: 'https://workspace.example', token: TEST_TOKEN,
      };
      const returned: DatabricksSetupResponse = await client.setupDatabricks(request);
      // Missing profile fails here even if status still contains a profile.
      expect(returned).toHaveProperty('profile');
      expect(returned.profile.id).toMatch(/^dbc_[a-f0-9]{32}$/);
      expect(returned.profile.auth).toBe('authenticated');
      expect(returned.status).toMatchObject({ setupRequired: false, auth: 'authenticated' });
      expect(returned.status.profiles).toContainEqual(returned.profile);
      expect(setup).toHaveBeenCalledExactlyOnceWith(request);
      expect(JSON.stringify(returned)).not.toContain(TEST_TOKEN);
      expect(JSON.stringify(returned)).not.toContain('workspace.example');

      // Use only the returned profile, never a fixture ID or status fallback.
      // An unknown/unusable ID must fail the actual scan, not just a shape check.
      const started = await client.startDatabricksScan({ profileId: returned.profile.id });
      scanId = started.scanId;
      expect(startScan).toHaveBeenCalledExactlyOnceWith({ profileId: returned.profile.id });
      expect(started.profileId).toBe(returned.profile.id);
      const events: DatabricksScanEvent[] = [];
      expect(await client.streamDatabricksScanEvents(scanId, {
        onEvent: (event) => events.push(event),
      }, { signal: AbortSignal.timeout(5000) })).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        scan: {
          scanId, profileId: returned.profile.id, state: 'complete', issues: [],
          completeness: { serving: true, uc: true, truncated: false },
        },
      });
      expect(workspaceFetch).toHaveBeenCalledTimes(3);
    } finally {
      scanSubscribed();
      if (scanId) await service.cancelScan(scanId);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      server.closeAllConnections();
      if (server.listening) {
        await bounded(new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        }));
      }
      await rm(dataRoot, { recursive: true, force: true });
    }
  }, 15000);
});
