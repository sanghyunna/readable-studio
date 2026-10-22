import { requestJsonIpc, resolveAppIpcPath, resolveNamespace } from '@readable-studio/sidecar';
import { setTimeout } from 'node:timers/promises';
import {
  APP_KEYS, SIDECAR_CONTRACT, SIDECAR_MESSAGES,
  type DesktopRenderHtmlThumbnailInput, type DesktopRenderHtmlThumbnailMessage,
  type DesktopRenderHtmlThumbnailResult,
} from '@readable-studio/sidecar-proto';

export type DesktopRenderUnavailable = { ok: false; code: 'desktop-unavailable'; error: string };
export type DesktopRenderFailure = Extract<DesktopRenderHtmlThumbnailResult, { ok: false }>;
export type DesktopRenderOptions = Partial<Omit<DesktopRenderHtmlThumbnailInput, 'url'>> & {
  namespace?: string;
  request?: (
    pipe: string, message: DesktopRenderHtmlThumbnailMessage, options: { timeoutMs: number },
  ) => Promise<DesktopRenderHtmlThumbnailResult>;
};

let pendingRender: Promise<void> = Promise.resolve();

export async function waitForDesktopRenderer(): Promise<boolean> {
  const namespace = resolveNamespace({ contract: SIDECAR_CONTRACT, namespace: null });
  const pipe = resolveAppIpcPath({ app: APP_KEYS.DESKTOP, contract: SIDECAR_CONTRACT, namespace });
  const deadline = Date.now() + 180_000;
  do {
    try {
      await requestJsonIpc(pipe, { type: SIDECAR_MESSAGES.STATUS }, { timeoutMs: 30_000 });
      return true;
    } catch {
      await setTimeout(250, undefined, { ref: false });
    }
  } while (Date.now() < deadline);
  return false;
}

// Transport adapter only: the daemon can initiate an ordinary JSON IPC request
// to the desktop's namespace-scoped pipe; no registration or new server needed.
export async function renderHtmlThumbnail(
  url: string, options: DesktopRenderOptions = {},
): Promise<Buffer | DesktopRenderUnavailable | DesktopRenderFailure> {
  const render = pendingRender.then<Buffer | DesktopRenderUnavailable | DesktopRenderFailure>(async () => {
    const input: DesktopRenderHtmlThumbnailInput = {
      url, width: options.width ?? 1920, height: options.height ?? 1080,
      outWidth: options.outWidth ?? 480, outHeight: options.outHeight ?? 270,
      timeoutMs: options.timeoutMs ?? 120_000,
    };
    const namespace = resolveNamespace({ contract: SIDECAR_CONTRACT, namespace: options.namespace ?? null });
    const pipe = resolveAppIpcPath({ app: APP_KEYS.DESKTOP, contract: SIDECAR_CONTRACT, namespace });
    try {
      const result = await (options.request ?? requestJsonIpc<DesktopRenderHtmlThumbnailResult>)(
        pipe, { type: SIDECAR_MESSAGES.RENDER_HTML_THUMBNAIL, input }, { timeoutMs: input.timeoutMs + 120_000 },
      );
      return result.ok ? Buffer.from(result.imageBase64, 'base64') : result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE') {
        return { ok: false, code: 'desktop-unavailable', error: message };
      }
      return { ok: false, code: 'THUMBNAIL_RENDER_FAILED', error: message };
    }
  });
  pendingRender = render.then(() => undefined, () => undefined);
  return render;
}
