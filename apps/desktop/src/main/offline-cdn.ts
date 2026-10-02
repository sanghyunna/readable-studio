type RequestResult = { redirectURL?: string };
type RequestSession = { webRequest: { onBeforeRequest(filter: { urls: string[] }, listener: ((details: { url: string }, callback: (result: RequestResult) => void) => Promise<void>) | null): void } };

const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'use.fontawesome.com', 'maxcdn.bootstrapcdn.com', 'stackpath.bootstrapcdn.com', 'kit.fontawesome.com', 'ka-f.fontawesome.com'];

/** The daemon owns URL resolution and its manifest; desktop shares no app-private code. */
export function installOfflineCdnHooks(
  sessions: { defaultSession: RequestSession; fromPartition(partition: string): RequestSession },
  designPartition: string,
  discoverOrigins: () => Promise<{ webOrigin: string; apiOrigin: string } | null>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): () => void {
  const targets = new Set([sessions.defaultSession, sessions.fromPartition(designPartition)]);
  const filter = { urls: CDN_HOSTS.flatMap(host => [`https://${host}/*`, `http://${host}/*`]) };
  for (const target of targets) target.webRequest.onBeforeRequest(filter, async (details, callback) => {
    let result: RequestResult = {};
    try {
      const origins = await discoverOrigins();
      if (origins) {
        const endpoint = new URL('/api/offline-cdn/resolve', origins.apiOrigin);
        endpoint.searchParams.set('url', details.url);
        const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Offline CDN resolver returned HTTP ${response.status}`);
        const resolution = await response.json() as { lib: string; major: number; path: string } | null;
        if (resolution) result = { redirectURL: new URL(`/offline-cdn/${resolution.lib}/${resolution.major}/${resolution.path}`, origins.webOrigin).toString() };
      }
    } catch (error) {
      console.warn('Offline CDN redirect unavailable; leaving original request unchanged.', error);
    }
    callback(result);
  });
  return () => { for (const target of targets) target.webRequest.onBeforeRequest(filter, null); };
}
