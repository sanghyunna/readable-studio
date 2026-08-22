import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer as createHttpServer,
  request as createHttpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { request as createHttpsRequest } from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { Duplex } from 'node:stream';
import { fileURLToPath } from "node:url";

import {
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  createRuntimeDescriptor,
  normalizeWebSidecarMessage,
  type SidecarStamp,
  type WebStatusSnapshot,
} from "@readable-studio/sidecar-proto";
import {
  createJsonIpcServer,
  type JsonIpcServerHandle,
  type SidecarRuntimeContext,
} from "@readable-studio/sidecar";

const HOST = process.env.READABLE_HOST || "127.0.0.1";
if (process.env.READABLE_HOST != null && !/^[a-zA-Z0-9._\-:[\]@]+$/.test(process.env.READABLE_HOST)) {
  throw new Error(`READABLE_HOST contains invalid characters: ${process.env.READABLE_HOST}`);
}
const DAEMON_HOST = "127.0.0.1";
const STANDALONE_BACKEND_HOST = "127.0.0.1";
const DAEMON_PORT_ENV = SIDECAR_ENV.DAEMON_PORT;
const WEB_DIST_DIR_ENV = SIDECAR_ENV.WEB_DIST_DIR;
const WEB_PORT_ENV = SIDECAR_ENV.WEB_PORT;
const TOOLS_DEV_PARENT_PID_ENV = SIDECAR_ENV.TOOLS_DEV_PARENT_PID;
const WEB_OUTPUT_MODE_ENV = "READABLE_WEB_OUTPUT_MODE";
const WEB_STANDALONE_ROOT_ENV = "READABLE_WEB_STANDALONE_ROOT";
const STANDALONE_PARENT_PID_ENV = "READABLE_STANDALONE_PARENT_PID";
const STANDALONE_STARTUP_TIMEOUT_ENV = "READABLE_STANDALONE_STARTUP_TIMEOUT_MS";
const WEB_COMPOSITION_ENV = 'READABLE_WEB_COMPOSITION';
const HOSTED_PUBLIC_ORIGIN_ENV = 'READABLE_HOSTED_PUBLIC_ORIGIN';
const HOSTED_BROWSER_COOKIE = '__Host-readable-hosted';
const HOSTED_PREVIEW_COOKIE = /^odpvb_[A-Za-z0-9_-]{22}$/u;
const HOSTED_PROXY_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-length',
  'content-type',
  'if-match',
  'if-none-match',
  'last-event-id',
  'origin',
  'pragma',
  'range',
  'referer',
  'user-agent',
  'x-readable-studio-csrf',
]);
const SHUTDOWN_TIMEOUT_MS = 3000;
const require = createRequire(import.meta.url);

type NextApp = {
  close?: () => Promise<void>;
  getRequestHandler(): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  getUpgradeHandler(): (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
  prepare(): Promise<void>;
};

type StandaloneBackend = {
  exitReason(): string | null;
  isRunning(): boolean;
  origin: string;
  stop(): Promise<void>;
};

function createNextApp(options: { dev: boolean; dir: string }): NextApp {
  const createNextServer = require("next") as (nextOptions: { dev: boolean; dir: string }) => NextApp;
  return createNextServer(options);
}

export type WebSidecarHandle = {
  status(): Promise<WebStatusSnapshot>;
  stop(): Promise<void>;
  waitUntilStopped(): Promise<void>;
};

function resolveWebRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const packageJson = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as { name?: unknown };
      if (packageJson.name === "@readable-studio/web") return current;
    } catch {
      // Keep walking until the package root is found. This must work from both
      // sidecar/*.ts under tsx and dist/sidecar/*.js in packaged installs.
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error("failed to resolve @readable-studio/web package root");
}

function parsePort(value: string | undefined): number {
  if (value == null || value.trim().length === 0) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${WEB_PORT_ENV} must be an integer between 0 and 65535`);
  }
  return port;
}

function parsePositiveIntegerEnv(envName: string, defaultValue: number): number {
  const value = process.env[envName];
  if (value == null || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer`);
  }
  return parsed;
}

export function resolveStandaloneStartupTimeoutMs(): number {
  // 120s default gives cold first-launch headroom while Windows Defender cold-scans the freshly extracted tree.
  return parsePositiveIntegerEnv(STANDALONE_STARTUP_TIMEOUT_ENV, 120_000);
}

export function createStandaloneParentMonitorImport(parentPidEnv = STANDALONE_PARENT_PID_ENV): string {
  const source = `
const parentPid = Number(process.env[${JSON.stringify(parentPidEnv)}]);
if (Number.isInteger(parentPid) && parentPid > 0) {
  const isParentAlive = () => {
    try {
      process.kill(parentPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const timer = setInterval(() => {
    if (process.ppid === parentPid && isParentAlive()) return;
    process.exit(0);
  }, 1000);
  timer.unref?.();
}
`;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

export function createStandaloneServerArgs(entryPath: string): string[] {
  return ["--import", createStandaloneParentMonitorImport(), entryPath];
}

export function resolveStandaloneBackendOrigin(port: number): string {
  return `http://${STANDALONE_BACKEND_HOST}:${port}`;
}

export function createStandaloneBackendEnv(options: {
  baseEnv?: NodeJS.ProcessEnv;
  parentPid?: number;
  port: number;
}): NodeJS.ProcessEnv {
  return {
    ...(options.baseEnv ?? process.env),
    HOSTNAME: STANDALONE_BACKEND_HOST,
    NODE_ENV: "production",
    PORT: String(options.port),
    [STANDALONE_PARENT_PID_ENV]: String(options.parentPid ?? process.pid),
  };
}

function resolveWebDistDir(webRoot: string): string {
  const configured = process.env[WEB_DIST_DIR_ENV];
  if (configured == null || configured.length === 0) return join(webRoot, ".next");
  return isAbsolute(configured) ? configured : join(webRoot, configured);
}

function resolveConfiguredStandaloneRoot(): string | null {
  const configured = process.env[WEB_STANDALONE_ROOT_ENV];
  if (configured == null || configured.length === 0) return null;
  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

export function resolveStandaloneServerEntry(
  webRoot: string | null = resolveWebRoot(),
  standaloneRoot: string | null = resolveConfiguredStandaloneRoot(),
): string | null {
  const configuredRoot = standaloneRoot == null || standaloneRoot.length === 0
    ? null
    : isAbsolute(standaloneRoot)
      ? standaloneRoot
      : join(process.cwd(), standaloneRoot);
  const candidates = [
    ...(configuredRoot == null
      ? []
      : [
        join(configuredRoot, "apps", "web", "server.js"),
        join(configuredRoot, "server.js"),
      ]),
    ...(webRoot == null
      ? []
      : [
        join(resolveWebDistDir(webRoot), "standalone", "apps", "web", "server.js"),
        join(resolveWebDistDir(webRoot), "standalone", "server.js"),
      ]),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function shouldUseStandaloneOutput(runtime: SidecarRuntimeContext<SidecarStamp>): boolean {
  return runtime.mode !== "dev" && process.env[WEB_OUTPUT_MODE_ENV] === "standalone";
}

function resolveDaemonOrigin(): string | null {
  const port = parsePort(process.env[DAEMON_PORT_ENV]);
  return port === 0 ? null : `http://${DAEMON_HOST}:${port}`;
}

function isDaemonProxyPathname(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/artifacts" ||
    pathname.startsWith("/artifacts/") ||
    pathname === "/frames" ||
    pathname.startsWith("/frames/")
  );
}

function hasPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function resolveHostedPublicOrigin(value: string | undefined): URL {
  const fail = () => {
    throw new Error(`${HOSTED_PUBLIC_ORIGIN_ENV} must be an exact HTTP(S) origin`);
  };
  if (value == null || value.length === 0 || value.trim() !== value) return fail();

  try {
    const origin = new URL(value);
    if (
      (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
      origin.username.length > 0 ||
      origin.password.length > 0 ||
      origin.pathname !== '/' ||
      origin.search.length > 0 ||
      origin.hash.length > 0
    ) {
      return fail();
    }
    return origin;
  } catch {
    return fail();
  }
}

export type HostedSidecarRoute =
  | { kind: 'daemon'; target: URL }
  | { kind: 'deny' | 'next' | 'unavailable' };

export function resolveHostedSidecarRoute(
  daemonOrigin: string | null,
  requestUrl: string | undefined,
): HostedSidecarRoute {
  if (hasHostedEncodedPathEscape(requestUrl)) return { kind: 'deny' };
  const parsed = resolveHttpProxyTarget(daemonOrigin ?? 'http://127.0.0.1', requestUrl);
  if (parsed == null) return { kind: 'deny' };
  if (hasPathPrefix(parsed.pathname, '/api')) {
    return daemonOrigin == null ? { kind: 'unavailable' } : { kind: 'daemon', target: parsed };
  }
  if (hasPathPrefix(parsed.pathname, '/artifacts') || hasPathPrefix(parsed.pathname, '/frames')) {
    return { kind: 'deny' };
  }
  return { kind: 'next' };
}

function hasHostedEncodedPathEscape(requestUrl: string | undefined): boolean {
  if (requestUrl == null) return true;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/[^?#]*)?/iu.exec(requestUrl);
  const rawPath = (absolute?.[1] ?? requestUrl).split(/[?#]/u, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  if (
    /%(?:2f|5c|25(?:2f|5c))/iu.test(rawPath)
    || /[\\\u0000-\u001f\u007f]/u.test(decoded)
    || decoded.split('/').some((segment) => segment === '.' || segment === '..')
  ) return true;

  const protectedPrefixes = ['/api', '/artifacts', '/frames'];
  return protectedPrefixes.some(
    (prefix) => hasPathPrefix(decoded, prefix) && !hasPathPrefix(rawPath, prefix),
  );
}

export function isHostedNextDevUpgrade(requestUrl: string | undefined): boolean {
  return requestUrl?.split('?', 1)[0] === '/_next/webpack-hmr';
}

export function createHostedDaemonProxyHeaders(options: {
  headers: IncomingHttpHeaders;
  publicOrigin: URL;
  remoteAddress: string | undefined;
  targetHost: string;
}): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(options.headers)) {
    if (HOSTED_PROXY_HEADER_ALLOWLIST.has(name.toLowerCase())) headers[name] = value;
  }
  const authorization = options.headers.authorization;
  if (typeof authorization === 'string' && /^Bearer [^\s]+$/u.test(authorization)) {
    headers.authorization = authorization;
  } else {
    const cookie = hostedBrowserCookies(options.headers.cookie);
    if (cookie != null) headers.cookie = cookie;
  }

  headers.host = options.targetHost;
  headers['x-forwarded-proto'] = options.publicOrigin.protocol.slice(0, -1);
  headers['x-forwarded-host'] = options.publicOrigin.host;
  headers['x-forwarded-port'] = options.publicOrigin.port || (options.publicOrigin.protocol === 'https:' ? '443' : '80');
  if (options.remoteAddress != null && options.remoteAddress.length > 0) {
    headers['x-forwarded-for'] = options.remoteAddress;
  }
  return headers;
}

function hostedBrowserCookies(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cookies = value
    .split(';')
    .map((part) => part.trim())
    .map((part) => ({ name: part.split('=', 1)[0] ?? '', value: part }));
  const session = cookies.filter(({ name }) => name === HOSTED_BROWSER_COOKIE);
  const preview = cookies.filter(({ name }) => HOSTED_PREVIEW_COOKIE.test(name));
  return [
    ...(session.length === 1 ? [session[0]!.value] : []),
    ...(preview.length === 1 ? [preview[0]!.value] : []),
  ].join('; ') || null;
}

export function resolveDaemonProxyTarget(
  daemonOrigin: string,
  requestUrl: string | undefined,
): URL | null {
  const target = resolveHttpProxyTarget(daemonOrigin, requestUrl);
  if (target == null || !isDaemonProxyPathname(target.pathname)) return null;
  return target;
}

function resolveHttpProxyTarget(
  origin: string,
  requestUrl: string | undefined,
): URL | null {
  if (requestUrl == null) return null;

  let parsedRequestUrl: URL;
  try {
    parsedRequestUrl = new URL(requestUrl, `http://${HOST}`);
  } catch {
    return null;
  }

  return new URL(`${parsedRequestUrl.pathname}${parsedRequestUrl.search}`, origin);
}

export function normalizeDaemonProxyOriginHeader(options: {
  daemonOrigin: string;
  origin: string | undefined;
  requestHost?: string | string[];
  webPort: number;
}): string | undefined {
  if (options.origin == null || options.origin.length === 0) return options.origin;

  const schemes = ["http", "https"];
  const loopbackHosts = ["127.0.0.1", "localhost", "[::1]", HOST];
  const allowedWebOrigins = new Set(
    schemes.flatMap((scheme) => loopbackHosts.map((host) => `${scheme}://${host}:${options.webPort}`)),
  );

  if (allowedWebOrigins.has(options.origin)) return options.daemonOrigin;

  const parsedOrigin = parseHttpOrigin(options.origin);
  if (
    parsedOrigin != null &&
    isSameBrowserHostOrigin({
      origin: parsedOrigin,
      requestHost: options.requestHost,
      webPort: options.webPort,
    })
  ) {
    return options.daemonOrigin;
  }

  return options.origin;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseHostHeader(value: string | string[] | undefined): URL | null {
  const raw = firstHeaderValue(value)?.trim();
  if (raw == null || raw.length === 0) return null;
  try {
    return new URL(`http://${raw}`);
  } catch {
    return null;
  }
}

function parseHttpOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function parseAllowedDevHost(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`http://${trimmed}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}

function configuredAllowedDevHosts(): Set<string> {
  return new Set(
    (process.env.READABLE_ALLOWED_DEV_ORIGINS ?? "")
      .split(",")
      .map(parseAllowedDevHost)
      .filter((host): host is string => host != null),
  );
}

function isAllowedDevHost(hostname: string, allowedHosts: Set<string>): boolean {
  const host = hostname.toLowerCase();
  if (allowedHosts.has(host)) return true;

  for (const allowedHost of allowedHosts) {
    if (!allowedHost.startsWith("*.")) continue;
    const suffix = allowedHost.slice(1);
    if (host.endsWith(suffix) && host.length > suffix.length) return true;
  }

  return false;
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  const octets = parts.map((part) => Number(part));
  if (!octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) return null;
  return octets as [number, number, number, number];
}

function isPrivateLanIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (octets == null) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isLoopbackOrPrivateLanHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host === "::" ||
    isPrivateLanIpv4(host)
  );
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function isSameBrowserHostOrigin(options: {
  origin: URL;
  requestHost?: string | string[];
  webPort: number;
}): boolean {
  const requestHost = parseHostHeader(options.requestHost);
  if (requestHost == null) return false;

  const originPort = options.origin.port || defaultPortForProtocol(options.origin.protocol);
  const requestPort = requestHost.port || "80";
  if (originPort !== String(options.webPort) || requestPort !== originPort) return false;
  if (requestHost.hostname.toLowerCase() !== options.origin.hostname.toLowerCase()) return false;

  const allowedDevHosts = configuredAllowedDevHosts();
  const originHost = options.origin.hostname.toLowerCase();
  return isLoopbackOrPrivateLanHost(originHost) || isAllowedDevHost(originHost, allowedDevHosts);
}

async function proxyHttpRequest(
  target: URL,
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    daemonWebPort?: number;
    hostedPublicOrigin?: URL;
  } = {},
): Promise<void> {
  const proxyRequestFactory = target.protocol === "https:" ? createHttpsRequest : createHttpRequest;
  const headers = options.hostedPublicOrigin == null
    ? { ...request.headers, host: target.host }
    : createHostedDaemonProxyHeaders({
      headers: request.headers,
      publicOrigin: options.hostedPublicOrigin,
      remoteAddress: request.socket.remoteAddress,
      targetHost: target.host,
    });
  if (options.daemonWebPort != null && options.hostedPublicOrigin == null) {
    const origin = normalizeDaemonProxyOriginHeader({
      daemonOrigin: target.origin,
      origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      requestHost: request.headers.host,
      webPort: options.daemonWebPort,
    });
    if (origin == null || origin.length === 0) {
      delete headers.origin;
    } else {
      headers.origin = origin;
    }
  }

  await new Promise<void>((resolveProxy) => {
    const proxyRequest = proxyRequestFactory(
      target,
      {
        headers,
        method: request.method,
      },
      (proxyResponse) => {
        response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(response);
        proxyResponse.on("end", resolveProxy);
      },
    );

    proxyRequest.on("error", (error) => {
      if (!response.headersSent) {
        response.statusCode = 502;
        response.setHeader("content-type", "text/plain; charset=utf-8");
      }
      response.end(error instanceof Error ? error.message : String(error));
      resolveProxy();
    });

    request.pipe(proxyRequest);
  });
}

async function prepareNextApp(app: { prepare(): Promise<void> }, dir: string): Promise<void> {
  const nextEnvPath = join(dir, "next-env.d.ts");
  const previousNextEnv = await readFile(nextEnvPath, "utf8").catch(() => null);
  await app.prepare();
  if (previousNextEnv == null) {
    await rm(nextEnvPath, { force: true }).catch(() => undefined);
    return;
  }
  await writeFile(nextEnvPath, previousNextEnv, "utf8").catch(() => undefined);
}

async function listen(server: HttpServer | TcpServer, port: number, host = HOST): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host, port }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo | string | null;
  if (address == null || typeof address === "string") {
    throw new Error("failed to resolve Next.js server address");
  }
  return address.port;
}

async function closeServer(server: HttpServer | TcpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error == null ? resolveClose() : rejectClose(error)));
  });
}

async function reserveTcpPort(host = HOST): Promise<number> {
  const server = createTcpServer();
  try {
    return await listen(server, 0, host);
  } finally {
    await closeServer(server).catch(() => undefined);
  }
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;

  await new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
}

async function stopStandaloneChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;

  child.kill("SIGTERM");
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      waitForChildExit(child),
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }

  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
    await waitForChildExit(child).catch(() => undefined);
  }
}

async function probeStandaloneBackend(origin: string): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe) => {
    const request = createHttpRequest(new URL("/", origin), { method: "HEAD", timeout: 800 }, (response) => {
      response.resume();
      resolveProbe(true);
    });
    request.on("timeout", () => {
      request.destroy();
      resolveProbe(false);
    });
    request.on("error", () => resolveProbe(false));
    request.end();
  });
}

async function waitForStandaloneBackendReady(
  child: ChildProcess,
  origin: string,
  timeoutMs = resolveStandaloneStartupTimeoutMs(),
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null || child.signalCode != null) {
      const elapsedMs = Date.now() - startedAt;
      const likelyPortRace = elapsedMs <= 200;
      throw new Error(
        `standalone Next.js server exited before readiness after ${elapsedMs}ms: code=${child.exitCode} signal=${child.signalCode}`
        + (likelyPortRace
          ? "; the reserved startup port may have been claimed before the child process bound it, retry the launch"
          : ""),
      );
    }
    if (await probeStandaloneBackend(origin)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }

  throw new Error(`timed out after ${timeoutMs}ms waiting for standalone Next.js server at ${origin}; override with ${STANDALONE_STARTUP_TIMEOUT_ENV}`);
}

async function startStandaloneBackend(webRoot: string | null): Promise<StandaloneBackend> {
  const entryPath = resolveStandaloneServerEntry(webRoot);
  if (entryPath == null) {
    throw new Error(
      webRoot == null
        ? `missing Next.js standalone server under ${WEB_STANDALONE_ROOT_ENV}; configure ${WEB_STANDALONE_ROOT_ENV} or install @readable-studio/web`
        : `missing Next.js standalone server under ${resolveWebDistDir(webRoot)}; rebuild with ${WEB_OUTPUT_MODE_ENV}=standalone`,
    );
  }

  const port = await reserveTcpPort(STANDALONE_BACKEND_HOST);
  const origin = resolveStandaloneBackendOrigin(port);
  console.log(`[readable-studio web] starting standalone Next.js server from ${entryPath}`);
  const child = spawn(process.execPath, createStandaloneServerArgs(entryPath), {
    cwd: dirname(entryPath),
    env: createStandaloneBackendEnv({ port }),
    stdio: ["ignore", "inherit", "inherit"],
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("error", rejectSpawn);
    child.once("spawn", resolveSpawn);
  });
  let standaloneRunning = true;
  let standaloneExitReason: string | null = null;
  child.once("exit", (code, signal) => {
    standaloneRunning = false;
    standaloneExitReason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    console.error(`[readable-studio web] standalone Next.js server exited ${standaloneExitReason}`);
  });

  try {
    await waitForStandaloneBackendReady(child, origin);
  } catch (error) {
    await stopStandaloneChild(child).catch(() => undefined);
    throw error;
  }

  return {
    exitReason() {
      return standaloneExitReason;
    },
    isRunning() {
      return standaloneRunning && child.exitCode == null && child.signalCode == null;
    },
    origin,
    async stop() {
      await stopStandaloneChild(child);
    },
  };
}

async function settleShutdownTask(task: Promise<unknown> | undefined): Promise<void> {
  if (task == null) return;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      task.catch(() => undefined),
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

function stopThenExit(stop: () => Promise<void>): void {
  const hardExit = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS + 1000);
  hardExit.unref();
  void stop().finally(() => {
    clearTimeout(hardExit);
    process.exit(0);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function attachParentMonitor(stop: () => Promise<void>): void {
  const parentPid = Number(process.env[TOOLS_DEV_PARENT_PID_ENV]);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;

  const timer = setInterval(() => {
    if (isProcessAlive(parentPid)) return;
    clearInterval(timer);
    stopThenExit(stop);
  }, 1000);
  timer.unref();
}

export function resolveWebAppVersion(
  webRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.READABLE_APP_VERSION?.trim();
  if (configured != null && configured.length > 0) return configured;
  if (webRoot == null) return "0.0.0";
  const packageMetadata = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as { version?: unknown };
  return typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";
}

async function createWebSidecarHandle(
  runtime: SidecarRuntimeContext<SidecarStamp>,
  httpServer: HttpServer,
  closeRuntime: () => Promise<void> | void,
  webRoot: string | null,
  isRuntimeRunning?: () => boolean,
): Promise<WebSidecarHandle> {
  const port = await listen(httpServer, parsePort(process.env[WEB_PORT_ENV]));
  const appVersion = resolveWebAppVersion(webRoot);
  const state: WebStatusSnapshot = {
    descriptor: createRuntimeDescriptor(appVersion),
    pid: process.pid,
    state: "running",
    updatedAt: new Date().toISOString(),
    url: `http://${HOST}:${port}`,
  };
  let ipcServer: JsonIpcServerHandle | null = null;
  let stopped = false;
  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>((resolveStop) => {
    resolveStopped = resolveStop;
  });

  function refreshRuntimeState(): void {
    if (stopped || isRuntimeRunning == null || isRuntimeRunning()) return;
    state.state = "stopped";
    state.url = null;
    state.updatedAt = new Date().toISOString();
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    state.state = "stopped";
    state.updatedAt = new Date().toISOString();
    await settleShutdownTask(ipcServer?.close());
    await settleShutdownTask(closeServer(httpServer));
    await settleShutdownTask(Promise.resolve().then(closeRuntime));
    resolveStopped();
  }

  attachParentMonitor(stop);

  ipcServer = await createJsonIpcServer({
    socketPath: runtime.ipc,
    handler: async (message: unknown) => {
      const request = normalizeWebSidecarMessage(message);
      switch (request.type) {
        case SIDECAR_MESSAGES.STATUS:
          refreshRuntimeState();
          return { ...state };
        case SIDECAR_MESSAGES.SHUTDOWN:
          setImmediate(() => {
            stopThenExit(stop);
          });
          return { accepted: true };
      }
    },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopThenExit(stop);
    });
  }

  return {
    async status() {
      refreshRuntimeState();
      return { ...state };
    },
    stop,
    waitUntilStopped() {
      return stoppedPromise;
    },
  };
}

function createDaemonProxyHandler(
  daemonOrigin: string | null,
  fallback: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  hostedPublicOrigin: URL | null = null,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (hostedPublicOrigin != null) {
      request.headers = createHostedDaemonProxyHeaders({
        headers: request.headers,
        publicOrigin: hostedPublicOrigin,
        remoteAddress: request.socket.remoteAddress,
        targetHost: firstHeaderValue(request.headers.host) ?? hostedPublicOrigin.host,
      }) as IncomingHttpHeaders;
      const route = resolveHostedSidecarRoute(daemonOrigin, request.url);
      if (route.kind === 'deny') {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      if (route.kind === 'unavailable') {
        response.statusCode = 502;
        response.end('daemon is not available');
        return;
      }
      if (route.kind === 'daemon') {
        void proxyHttpRequest(route.target, request, response, { hostedPublicOrigin }).catch((error: unknown) => {
          response.statusCode = 502;
          response.end(error instanceof Error ? error.message : String(error));
        });
        return;
      }
    }

    const daemonProxyTarget = daemonOrigin == null ? null : resolveDaemonProxyTarget(daemonOrigin, request.url);
    if (daemonProxyTarget != null) {
      const localPort = request.socket.localPort;
      void proxyHttpRequest(daemonProxyTarget, request, response, {
        daemonWebPort: typeof localPort === "number" ? localPort : 0,
      }).catch((error: unknown) => {
        response.statusCode = 502;
        response.end(error instanceof Error ? error.message : String(error));
      });
      return;
    }

    void fallback(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  };
}

async function startRegularNextSidecar(
  runtime: SidecarRuntimeContext<SidecarStamp>,
  webRoot: string,
  hostedPublicOrigin: URL | null,
): Promise<WebSidecarHandle> {
  const dev = process.env.READABLE_WEB_PROD !== '1' && runtime.mode === 'dev';
  const app = createNextApp({ dev, dir: webRoot });
  await prepareNextApp(app, webRoot);

  const daemonOrigin = resolveDaemonOrigin();
  const handleRequest = app.getRequestHandler();
  const httpServer = createHttpServer(createDaemonProxyHandler(daemonOrigin, handleRequest, hostedPublicOrigin));
  if (hostedPublicOrigin != null) {
    const handleUpgrade = app.getUpgradeHandler();
    httpServer.on('upgrade', (request, socket, head) => {
      if (!dev || !isHostedNextDevUpgrade(request.url)) {
        socket.destroy();
        return;
      }
      void handleUpgrade(request, socket, head).catch(() => socket.destroy());
    });
  }

  return await createWebSidecarHandle(runtime, httpServer, async () => {
    await app.close?.();
  }, webRoot);
}

async function startStandaloneNextSidecar(
  runtime: SidecarRuntimeContext<SidecarStamp>,
  webRoot: string | null,
  hostedPublicOrigin: URL | null,
): Promise<WebSidecarHandle> {
  const daemonOrigin = resolveDaemonOrigin();
  const backend = await startStandaloneBackend(webRoot);
  const httpServer = createHttpServer(createDaemonProxyHandler(daemonOrigin, async (request, response) => {
    if (!backend.isRunning()) {
      response.statusCode = 502;
      response.end(`standalone Next.js server is not running${backend.exitReason() == null ? "" : ` (${backend.exitReason()})`}`);
      return;
    }
    const target = resolveHttpProxyTarget(backend.origin, request.url);
    if (target == null) {
      response.statusCode = 400;
      response.end("invalid request URL");
      return;
    }
    await proxyHttpRequest(target, request, response);
  }, hostedPublicOrigin));
  if (hostedPublicOrigin != null) httpServer.on('upgrade', (_request, socket) => socket.destroy());

  try {
    return await createWebSidecarHandle(runtime, httpServer, backend.stop, webRoot, backend.isRunning);
  } catch (error) {
    await backend.stop().catch(() => undefined);
    throw error;
  }
}

export async function startWebSidecar(runtime: SidecarRuntimeContext<SidecarStamp>): Promise<WebSidecarHandle> {
  const hostedPublicOrigin = process.env[WEB_COMPOSITION_ENV] === 'hosted'
    ? resolveHostedPublicOrigin(process.env[HOSTED_PUBLIC_ORIGIN_ENV])
    : null;
  if (shouldUseStandaloneOutput(runtime)) {
    const webRoot = resolveConfiguredStandaloneRoot() == null ? resolveWebRoot() : null;
    return await startStandaloneNextSidecar(runtime, webRoot, hostedPublicOrigin);
  }

  const webRoot = resolveWebRoot();
  return await startRegularNextSidecar(runtime, webRoot, hostedPublicOrigin);
}
