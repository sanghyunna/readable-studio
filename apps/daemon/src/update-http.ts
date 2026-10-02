import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { addLoopbackNoProxyEnv } from '@readable-studio/platform';

/** Update-only transport: dependency imports can replace Node's global env-proxy dispatcher. */
export function createUpdateHttpClient(env: NodeJS.ProcessEnv = process.env) {
  const allProxy = env.all_proxy ?? env.ALL_PROXY ?? '';
  const directLoopbackEnv = addLoopbackNoProxyEnv(env);
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? allProxy,
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY ?? allProxy,
    noProxy: directLoopbackEnv.no_proxy ?? directLoopbackEnv.NO_PROXY ?? '',
  });
  return {
    // Keep Node's default TLS trust, including NODE_EXTRA_CA_CERTS loaded at startup.
    // Use Undici's matching fetch/dispatcher API, not the runtime's bundled Undici API.
    fetch: async (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }): Promise<Response> =>
      await undiciFetch(url, { ...init, dispatcher }) as unknown as Response,
    destroy: () => dispatcher.destroy(),
  };
}
