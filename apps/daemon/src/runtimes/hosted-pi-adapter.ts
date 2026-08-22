import path from 'node:path';
import { SIDECAR_CONTRACT } from '@readable-studio/sidecar-proto';
import {
  createHostedPiBroker,
  type HostedPiBroker,
} from './hosted-pi-broker.js';
import {
  createHostedPiInvocation,
  type HostedPiInvocationOptions,
  type HostedPiDesignSystemGrant,
  type HostedPiDesignSystemTool,
  type HostedPiRuntimeAdapter,
  type HostedPiRuntimeRequest,
} from './hosted-pi-runtime.js';

export type HostedPiRuntimeAdapterOptions = {
  /** A server-owned writable root for one run's broker socket and session files. */
  runtimeRoot: string;
  packageRoot?: string;
  sessionRoot?: string;
  socketBase?: string;
  designSystemTool?: HostedPiDesignSystemTool;
};

function safeRunId(runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(runId)) {
    throw new Error('hosted Pi run id is invalid');
  }
  return runId;
}

function safeDesignSystemSelection(request: HostedPiRuntimeRequest): string | null {
  const designSystemId = request.designSystemId ?? null;
  if (designSystemId === null) return null;
  if (
    typeof designSystemId !== 'string'
    || !/^(?!\.+$)[A-Za-z0-9._-]{1,128}$/u.test(designSystemId)
  ) throw new Error('hosted Pi design-system selection is invalid');
  return designSystemId;
}

async function closeCapabilities(
  broker: HostedPiBroker,
  designSystemGrant: HostedPiDesignSystemGrant | null,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => designSystemGrant?.revoke()),
    broker.close(),
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

/**
 * Compose the server-owned hosted Pi broker and package-local invocation.
 * The request's userKey is copied by the authenticated hosted composition;
 * Pi and clients never supply the binding.
 */
export function createHostedPiRuntimeAdapter(
  options: HostedPiRuntimeAdapterOptions,
): HostedPiRuntimeAdapter {
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const sessionRoot = path.resolve(options.sessionRoot ?? path.join(runtimeRoot, 'sessions'));
  const socketBase = path.resolve(options.socketBase ?? SIDECAR_CONTRACT.defaults.ipcBase);
  return async (request) => {
    const runId = safeRunId(request.runId);
    if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
      throw new Error('hosted Pi generation is invalid');
    }
    const designSystemId = safeDesignSystemSelection(request);
    if (designSystemId !== null && !options.designSystemTool) {
      throw new Error('hosted Pi design-system tool is unavailable');
    }
    const broker: HostedPiBroker = await createHostedPiBroker({
      runtimeRoot,
      socketBase,
      binding: {
        generation: request.generation,
        userKey: request.userKey,
        runId,
        projectId: request.projectId,
        projectRoot: request.projectRoot,
      },
    });
    let designSystemGrant: HostedPiDesignSystemGrant | null = null;
    try {
      if (designSystemId !== null && options.designSystemTool) {
        designSystemGrant = await options.designSystemTool.mintGrant({
          userKey: request.userKey,
          runId,
          projectId: request.projectId,
          generation: request.generation,
          designSystemId,
          carrierToken: broker.token,
        });
      }
      const invocationOptions: HostedPiInvocationOptions = {
        ...(options.packageRoot ? { packageRoot: options.packageRoot } : {}),
        cwd: request.cwd,
        ...(request.credential ? { credential: request.credential } : {}),
        sessionDir: path.join(sessionRoot, runId),
        broker,
        ...(designSystemGrant && options.designSystemTool
          ? {
              designSystemTool: {
                readUrl: options.designSystemTool.readUrl,
                token: designSystemGrant.token,
              },
            }
          : {}),
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
      };
      const invocation = createHostedPiInvocation(invocationOptions);
      let closed = false;
      return {
        invocation,
        close: async () => {
          if (closed) return;
          closed = true;
          await closeCapabilities(broker, designSystemGrant);
        },
      };
    } catch (error) {
      try { await closeCapabilities(broker, designSystemGrant); } catch { /* preserve setup failure */ }
      throw error;
    }
  };
}
