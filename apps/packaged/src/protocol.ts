import { request as createHttpRequest } from 'node:http';
import { request as createHttpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { protocol } from "electron";
import type { StartupNoticeState } from './onedrive.js';

const READABLE_STUDIO_SCHEME = "readable-studio";
const READABLE_STUDIO_AUTHORITY = "app";
const READABLE_STUDIO_ENTRY_URL = `${READABLE_STUDIO_SCHEME}://${READABLE_STUDIO_AUTHORITY}/`;

protocol.registerSchemesAsPrivileged([
  {
    privileges: {
      corsEnabled: true,
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
    },
    scheme: READABLE_STUDIO_SCHEME,
  },
]);

function toWebRuntimeUrl(webRuntimeUrl: string, requestUrl: string): string {
  const incoming = new URL(requestUrl);
  const target = new URL(webRuntimeUrl);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  target.hash = incoming.hash;
  return target.toString();
}

function buildProxyErrorResponse(error: unknown, target: string): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
      ? (error as NodeJS.ErrnoException).code
      : null;
  return new Response(
    JSON.stringify({
      error: "READABLE_STUDIO_PROTOCOL_PROXY_FAILED",
      message,
      ...(code === null ? {} : { code }),
      target,
    }),
    {
      status: 502,
      headers: { "content-type": "application/json" },
    },
  );
}

async function logReadableStudioProtocolResponse(response: Response, target: string): Promise<void> {
  if (process.env.READABLE_STUDIO_PROTOCOL_DIAG !== "1") return;

  const contentType = response.headers.get("content-type") ?? "unknown";
  const title = contentType.toLowerCase().includes("text/html")
    ? /<title[^>]*>([^<]*)<\/title>/i
      .exec(await response.clone().text().catch(() => ""))?.[1]
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 160)
    : null;
  console.warn(
    `[readable-studio packaged] readable-studio proxy response status=${response.status} contentType=${contentType}${title ? ` title=${JSON.stringify(title)}` : ""} target=${target} url=${response.url || "unknown"}`,
  );
}

async function fetchWebSidecar(input: RequestInfo | URL, init?: RequestInit, redirectsRemaining = 20): Promise<Response> {
  const request = new Request(input, init);
  const target = new URL(request.url);
  const transport = target.protocol === 'https:' ? createHttpsRequest : createHttpRequest;
  const headers = Object.fromEntries(request.headers);
  // The response is streamed without fetch's automatic decompression.
  headers['accept-encoding'] = 'identity';
  const body = request.body === null ? null : Buffer.from(await request.arrayBuffer());
  const response = await new Promise<Response>((resolve, reject) => {
    // Never inherit an env-aware global agent for renderer-to-sidecar traffic.
    const proxy = transport(target, { agent: false, method: request.method, headers, signal: request.signal }, (incoming) => {
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      }
      const status = incoming.statusCode ?? 502;
      const empty = request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
      if (empty) incoming.resume();
      resolve(new Response(empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status, statusText: incoming.statusMessage, headers: responseHeaders,
      }));
    });
    proxy.on('error', reject);
    proxy.end(body);
  });
  const location = response.headers.get('location');
  if (location !== null && [301, 302, 303, 307, 308].includes(response.status) && request.redirect !== 'manual') {
    await response.body?.cancel();
    if (request.redirect === 'error' || redirectsRemaining === 0) throw new TypeError('Sidecar redirect rejected');
    const nextTarget = new URL(location, target);
    const useGet = ((response.status === 301 || response.status === 302) && request.method === 'POST')
      || (response.status === 303 && request.method !== 'GET' && request.method !== 'HEAD');
    if (useGet) {
      delete headers['content-type'];
      delete headers['content-length'];
    }
    if (nextTarget.origin !== target.origin) {
      delete headers.authorization;
      delete headers.cookie;
    }
    return await fetchWebSidecar(nextTarget, {
      method: useGet ? 'GET' : request.method, headers, body: useGet ? null : body,
      signal: request.signal, redirect: request.redirect,
    }, redirectsRemaining - 1);
  }
  return response;
}

/**
 * Inner request handler for the `readable-studio://` Electron protocol — every
 * renderer fetch flows through here and gets proxied to the local web
 * sidecar via a direct Node HTTP transport, independent of proxy environment.
 *
 * Pulled out as a named export so unit tests can drive it with a stub
 * `fetchImpl` without spinning up Electron, and so the try/catch
 * stays auditable from one place.
 *
 * Why the try/catch matters: undici can throw `setTypeOfService
 * EINVAL` from socket internals on certain macOS / VPN configurations
 * (issue #895). Without the catch, the rejection bubbles all the way
 * up to the Electron main process and surfaces as a native
 * "JavaScript error in main process" dialog the next time the user
 * does anything that triggers a renderer-to-sidecar fetch (e.g.
 * Settings → Pets → Community). Returning a 502 instead lets the
 * renderer see a normal failure and keeps the process alive.
 */
// @dsp func-ecffde00
export async function handleReadableStudioRequest(
  request: Request,
  webRuntimeUrl: string,
  fetchImpl: typeof fetch = fetchWebSidecar,
  startupState?: StartupNoticeState,
): Promise<Response> {
  const incoming = new URL(request.url);
  if (incoming.protocol !== `${READABLE_STUDIO_SCHEME}:` || incoming.hostname !== READABLE_STUDIO_AUTHORITY) {
    return new Response(
      JSON.stringify({ error: "READABLE_STUDIO_PROTOCOL_REQUEST_INVALID" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (incoming.pathname === '/__packaged/startup-state' && startupState) {
    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin !== null && origin !== 'readable-studio://app') return new Response(null, { status: 403 });
      try { await startupState.dismiss(); }
      catch (error) {
        console.error('Could not persist OneDrive notice dismissal', error);
        return new Response(null, { status: 500 });
      }
    } else if (request.method !== 'GET') return new Response(null, { status: 405 });
    return new Response(JSON.stringify(startupState.snapshot()), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  const target = toWebRuntimeUrl(webRuntimeUrl, request.url);
  try {
    const response = await fetchImpl(new Request(target, request));
    await logReadableStudioProtocolResponse(response, target);
    return response;
  } catch (error) {
    return buildProxyErrorResponse(error, target);
  }
}

// @dsp func-caecdacf
export function packagedEntryUrl(): string {
  return READABLE_STUDIO_ENTRY_URL;
}

// @dsp func-97bde04f
export function registerReadableStudioProtocol(webRuntimeUrl: string, startupState?: StartupNoticeState): void {
  protocol.handle(READABLE_STUDIO_SCHEME, async (request) => {
    return await handleReadableStudioRequest(request, webRuntimeUrl, fetchWebSidecar, startupState);
  });
}
