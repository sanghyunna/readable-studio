import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createConnection } from 'node:net';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import {
  startHostedServer,
  type HostedResolvedIdentity,
  type HostedRuntimeCapacitySnapshot,
  type HostedRuntimeMeasurement,
} from '@readable-studio/daemon/hosted-server';
import { startHostedPiTurn } from '@readable-studio/daemon/hosted-pi-turn';
import { HOSTED_CAPACITY_IDENTITIES, type HostedMeasurement } from './hosted.ts';

type FixtureConfig = {
  idleEvictionMs: number;
  launchId: number;
  port: number;
  providerBaseUrl: string;
  publicOrigin: string;
  runtimeRoot: string;
};

const EVENT_LOOP_RESOLUTION_MS = 10;

const identities: Readonly<Record<string, HostedResolvedIdentity>> = Object.freeze({
  a: Object.freeze({
    displayName: 'Hosted A',
    sessionKey: 'hosted-acceptance-session-a',
    userKey: 'hosted-acceptance-user-a',
  }),
  b: Object.freeze({
    displayName: 'Hosted B',
    sessionKey: 'hosted-acceptance-session-b',
    userKey: 'hosted-acceptance-user-b',
  }),
  ...Object.fromEntries(HOSTED_CAPACITY_IDENTITIES.map((identity) => [identity, Object.freeze({
    displayName: `Hosted ${identity.toUpperCase()}`,
    sessionKey: `hosted-capacity-session-${identity}`,
    userKey: `hosted-capacity-user-${identity}`,
  })])),
});

type BrokerBinding = { socketPath: string; token: string };
const brokerBindings = new Map<string, BrokerBinding>();
let grantProbe = deferred();
let grantProbeStarted = false;
let grantProbeVerified = false;

if (process.env.NODE_ENV !== 'test') fail();

try {
  const config = readConfig(process.argv[2]);
  const counters = new Map<string, number>();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  const operationMeasurements: HostedRuntimeMeasurement[] = [];
  let childCurrent = 0;
  let childPeak = 0;
  let runtimeProbe: (() => HostedRuntimeCapacitySnapshot) | null = null;
  eventLoopDelay.enable();
  const hosted = await startHostedServer({
    host: '127.0.0.1',
    port: config.port,
    publicOrigin: config.publicOrigin,
    runtimeRoot: config.runtimeRoot,
    testComposition: {
      createEntityId(kind, userKey) {
        return nextId(counters, config.launchId, userKey, kind);
      },
      createRunId(userKey) {
        return nextId(counters, config.launchId, userKey, 'run');
      },
      eventBudgetLimits: { heartbeatMs: 100 },
      idleEvictionMs: config.idleEvictionMs,
      onRuntimeMeasurement(measurement) {
        operationMeasurements.push(Object.freeze({ ...measurement }));
      },
      providerBaseUrls: {
        anthropic: config.providerBaseUrl,
        'vercel-ai-gateway': config.providerBaseUrl,
      },
      resolveIdentity(request) {
        const bearer = bearerIdentity(request.headers.authorization);
        const cookie = cookieIdentity(request.headers.cookie);
        if (bearer === null || cookie === null || (bearer && cookie && bearer !== cookie)) {
          return null;
        }
        const identity = bearer ?? cookie;
        return identity === undefined ? null : identities[identity] ?? null;
      },
      registerRuntimeProbe(read) {
        runtimeProbe = read;
      },
      startTurn(input, dependencies) {
        let grantIsolation = Promise.resolve();
        return startHostedPiTurn(input, {
          ...dependencies,
          spawnChild(command, args, options) {
            if (input.prompt.includes('[probe-grant-isolation]')) {
              grantIsolation = captureBrokerBinding(input.capabilities.userKey, options.env);
            }
            fs.writeFileSync(
              path.join(options.env!.PI_CODING_AGENT_DIR!, 'models.json'),
              JSON.stringify({ providers: { anthropic: { baseUrl: config.providerBaseUrl } } }),
            );
            const child = spawn(command, [...args], options);
            childCurrent += 1;
            childPeak = Math.max(childPeak, childCurrent);
            let childSettled = false;
            const settleChild = (): void => {
              if (childSettled) return;
              childSettled = true;
              childCurrent -= 1;
            };
            child.once('spawn', () => {
              process.stderr.write(`${JSON.stringify({ type: 'pi-child', event: 'spawn' })}\n`);
            });
            child.once('close', (exitCode, signal) => {
              settleChild();
              process.stderr.write(`${JSON.stringify({
                type: 'pi-child', event: 'close', exitCode, signal,
              })}\n`);
            });
            child.once('error', (error) => {
              settleChild();
              process.stderr.write(`${JSON.stringify({
                type: 'pi-child', event: 'error', code: (error as NodeJS.ErrnoException).code ?? null,
              })}\n`);
            });
            child.stderr?.on('data', (chunk: Buffer | string) => {
              let text = String(chunk).slice(0, 2_000);
              for (const secret of Object.values(options.env ?? {})) {
                if (typeof secret === 'string' && secret.length > 3) text = text.replaceAll(secret, '[redacted]');
              }
              for (const owned of [config.providerBaseUrl, config.runtimeRoot, process.cwd()]) {
                text = text.replaceAll(owned, '[redacted]');
              }
              process.stderr.write(`${JSON.stringify({ type: 'pi-stderr', text })}\n`);
            });
            return child;
          },
        }).then(async (result) => {
          await grantIsolation;
          if (result.value.status === 'failed') {
            process.stderr.write(`${JSON.stringify({
              type: 'turn-terminal',
              exitCode: result.value.exitCode,
              signal: result.value.signal,
              status: result.value.status,
            })}\n`);
          }
          return result;
        }).catch((error: unknown) => {
          const failure = error as { code?: unknown; message?: unknown; name?: unknown };
          process.stderr.write(`${JSON.stringify({
            type: 'turn-failure',
            code: typeof failure.code === 'string' ? failure.code : null,
            message: typeof failure.message === 'string' ? failure.message : 'hosted turn failed',
            name: typeof failure.name === 'string' ? failure.name : 'Error',
          })}\n`);
          throw error;
        });
      },
    },
  });
  let stopping: Promise<void> | null = null;
  const stop = (exitCode: number): Promise<void> => {
    stopping ??= hosted.shutdown().then(() => {
      eventLoopDelay.disable();
      process.exitCode = exitCode;
      if (process.connected) process.disconnect();
    });
    return stopping;
  };
  process.on('message', (message: unknown) => {
    if (isShutdownMessage(message)) {
      void stop(0).catch(fail);
    } else if (isMeasureMessage(message)) {
      try {
        if (runtimeProbe == null) throw new Error('hosted runtime probe is unavailable');
        process.send?.({
          type: 'measurement',
          id: message.id,
          value: readMeasurement(runtimeProbe(), operationMeasurements, eventLoopDelay, {
            current: childCurrent,
            peak: childPeak,
          }),
        });
      } catch {
        process.send?.({
          type: 'measurement-error', id: message.id, message: 'hosted fixture measurement failed',
        });
      }
    }
  });
  process.once('disconnect', () => { void stop(0).catch(fail); });
  process.once('SIGINT', () => { void stop(0).catch(fail); });
  process.once('SIGTERM', () => { void stop(0).catch(fail); });
  if (!process.send) fail();
  process.send({ type: 'ready', url: hosted.url });
} catch {
  fail();
}

function readConfig(candidate: string | undefined): FixtureConfig {
  if (candidate == null || !path.isAbsolute(candidate)) fail();
  const stat = fs.lstatSync(candidate);
  const resolved = fs.realpathSync(candidate);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !samePath(candidate, resolved)
    || stat.size < 2
    || stat.size > 16 * 1024
  ) fail();
  const value: unknown = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (value == null || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',')
      !== 'idleEvictionMs,launchId,port,providerBaseUrl,publicOrigin,runtimeRoot'
  ) {
    fail();
  }
  if (
    !Number.isSafeInteger(record.launchId)
    || (record.launchId as number) < 1
    || !Number.isSafeInteger(record.port)
    || (record.port as number) < 1
    || (record.port as number) > 65_535
    || !Number.isSafeInteger(record.idleEvictionMs)
    || (record.idleEvictionMs as number) < 1
    || typeof record.runtimeRoot !== 'string'
    || !path.isAbsolute(record.runtimeRoot)
    || !isExactOrigin(record.publicOrigin, false)
    || !isExactOrigin(record.providerBaseUrl, true)
  ) fail();
  return {
    idleEvictionMs: record.idleEvictionMs as number,
    launchId: record.launchId as number,
    port: record.port as number,
    providerBaseUrl: record.providerBaseUrl as string,
    publicOrigin: record.publicOrigin as string,
    runtimeRoot: path.resolve(record.runtimeRoot),
  };
}

function isExactOrigin(value: unknown, loopbackOnly: boolean): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.origin === value
      && parsed.username === ''
      && parsed.password === ''
      && (loopbackOnly
        ? parsed.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)
        : parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function bearerIdentity(header: string | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer (a|b|u(?:0[1-9]|1[0-5]))$/u.exec(header);
  return match != null && isFixtureIdentity(match[1]) ? match[1] : null;
}

function cookieIdentity(header: string | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  const values = header.split(';').map((part) => part.trim()).flatMap((part) => {
    const index = part.indexOf('=');
    return index > 0 && part.slice(0, index) === '__Host-readable-hosted'
      ? [part.slice(index + 1)]
      : [];
  });
  return values.length === 0
    ? undefined
    : values.length === 1 && isFixtureIdentity(values[0])
      ? values[0]
      : null;
}

function isFixtureIdentity(value: string | undefined): value is string {
  return value !== undefined && Object.hasOwn(identities, value);
}

function nextId(
  values: Map<string, number>,
  launchId: number,
  userKey: string,
  kind: 'project' | 'conversation' | 'message' | 'run',
): string {
  const key = `${userKey}\0${kind}`;
  const value = (values.get(key) ?? 0) + 1;
  values.set(key, value);
  return kind === 'run'
    ? `${kind}-${launchId}-${userKey}-${value}`
    : `${kind}-${launchId}-${value}`;
}

function isShutdownMessage(value: unknown): boolean {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { type?: unknown }).type === 'shutdown';
}

function isMeasureMessage(value: unknown): value is { id: number; type: 'measure' } {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'id,type'
    && (value as { type?: unknown }).type === 'measure'
    && Number.isSafeInteger((value as { id?: unknown }).id)
    && ((value as { id: number }).id > 0);
}

function readMeasurement(
  registry: HostedRuntimeCapacitySnapshot,
  operations: readonly HostedRuntimeMeasurement[],
  eventLoopDelay: ReturnType<typeof monitorEventLoopDelay>,
  children: { current: number; peak: number },
): HostedMeasurement {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const resources = process.getActiveResourcesInfo();
  const eventLoopLagMs = {
    mean: finiteMilliseconds(eventLoopDelay.mean),
    max: finiteMilliseconds(eventLoopDelay.max),
    p99: finiteMilliseconds(eventLoopDelay.percentile(99)),
  };
  eventLoopDelay.reset();
  const byType: Record<string, number> = {};
  for (const resource of resources) byType[resource] = (byType[resource] ?? 0) + 1;
  const processors = cpus();
  return {
    atMs: Date.now(),
    host: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpuCount: processors.length,
      cpuModel: processors[0]?.model ?? 'unknown',
      totalMemoryBytes: totalmem(),
    },
    process: {
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      eventLoopUtilization: performance.eventLoopUtilization().utilization,
      eventLoopLagMs,
      synchronousBlockingMs: Math.max(0, eventLoopLagMs.max - EVENT_LOOP_RESOLUTION_MS),
      activeResources: { total: resources.length, byType },
      childCurrent: children.current,
      childPeak: children.peak,
    },
    registry,
    operations: [...operations],
  };
}

function finiteMilliseconds(nanoseconds: number): number {
  const value = nanoseconds / 1_000_000;
  return Number.isFinite(value) ? value : 0;
}

function captureBrokerBinding(
  userKey: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  if (grantProbeVerified) return Promise.resolve();
  const socketPath = env?.READABLE_HOSTED_PI_BROKER_SOCKET;
  const token = env?.READABLE_HOSTED_PI_BROKER_TOKEN;
  if (typeof socketPath !== 'string' || typeof token !== 'string') {
    return Promise.reject(new Error('hosted broker grant was not injected'));
  }
  brokerBindings.set(userKey, { socketPath, token });
  if (brokerBindings.size >= 2 && !grantProbeStarted) {
    grantProbeStarted = true;
    const [first, second] = [...brokerBindings.values()];
    void Promise.all([
      requestBroker(first!.socketPath, second!.token),
      requestBroker(second!.socketPath, first!.token),
    ]).then((responses) => {
      if (responses.some((response) => response.code !== 'BROKER_TOKEN_INVALID')) {
        throw new Error('cross-user hosted broker grant was accepted');
      }
      grantProbeVerified = true;
      grantProbe.resolve();
    }).catch(grantProbe.reject);
  }
  return grantProbe.promise;
}

function requestBroker(socketPath: string, token: string): Promise<{ code?: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('hosted broker grant probe timed out'));
    }, 5_000);
    timer.unref();
    let buffer = '';
    const settle = (action: () => void): void => {
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ token, operation: 'project:file:list', path: '' })}\n`);
    });
    socket.once('error', (error) => settle(() => reject(error)));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as { code?: unknown };
        settle(() => resolve(response));
      } catch (error) {
        settle(() => reject(error));
      }
    });
  });
}

function deferred(): {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function fail(): never {
  if (process.send) {
    try { process.send({ type: 'fatal', message: 'hosted acceptance launcher failed' }); } catch {}
  }
  process.stderr.write('hosted acceptance launcher failed\n');
  process.exit(1);
}
