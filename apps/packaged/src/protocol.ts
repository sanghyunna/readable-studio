import { protocol } from "electron";

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

/**
 * Inner request handler for the `readable-studio://` Electron protocol — every
 * renderer fetch flows through here and gets proxied to the local web
 * sidecar via Node's global `fetch` (which is undici under the hood).
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
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  if (incoming.protocol !== `${READABLE_STUDIO_SCHEME}:` || incoming.hostname !== READABLE_STUDIO_AUTHORITY) {
    return new Response(
      JSON.stringify({ error: "READABLE_STUDIO_PROTOCOL_REQUEST_INVALID" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
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
export function registerReadableStudioProtocol(webRuntimeUrl: string): void {
  protocol.handle(READABLE_STUDIO_SCHEME, async (request) => {
    return await handleReadableStudioRequest(request, webRuntimeUrl);
  });
}
