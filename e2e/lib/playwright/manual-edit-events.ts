import type { Page, Response } from '@playwright/test';
import { T } from '@/timeouts';

/** Arm the listener before the action, and dispose it on either outcome. */
export async function observeActiveFrameBridgeMessage<TMessage extends { type: string; documentEpoch: string; sequence: number }>(
  page: Page,
  expected: { type: string; targetId: string; documentEpoch: string; sequence: number },
  timeout = T.medium,
): Promise<{ promise: Promise<TMessage>; dispose: () => Promise<void> }> {
  const key = `__manualEditObserver${Math.random().toString(36).slice(2)}`;
  let settle!: (value: TMessage) => void;
  let fail!: (error: Error) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const promise = new Promise<TMessage>((resolve, reject) => { settle = resolve; fail = reject; });
  const dispose = async () => {
    clearTimeout(timer);
    await page.evaluate((name) => {
      const cleanup = (window as unknown as Record<string, (() => void) | undefined>)[name];
      cleanup?.();
      delete (window as unknown as Record<string, unknown>)[name];
    }, key).catch(() => undefined);
  };
  const finish = (value?: TMessage, error?: Error) => {
    if (settled) return;
    settled = true;
    void dispose();
    if (error) fail(error);
    else settle(value!);
  };
  await page.exposeBinding(key, (_source, message: TMessage) => finish(message));
  await page.evaluate(({ name, match }) => {
    const handler = (event: MessageEvent) => {
      const frame = [...document.querySelectorAll<HTMLIFrameElement>('[data-testid^="artifact-preview-frame"]')]
        .find((element) => element.getClientRects().length > 0);
      const data = event.data as { type?: string; documentEpoch?: string; sequence?: number; target?: { id?: string } } | null;
      if (event.source === frame?.contentWindow && data?.type === match.type
        && data.documentEpoch === match.documentEpoch && data.sequence === match.sequence
        && data.target?.id === match.targetId) {
        (window as unknown as Record<string, (value: unknown) => void>)[name]?.(data);
      }
    };
    window.addEventListener('message', handler);
    (window as unknown as Record<string, () => void>)[name] = () => window.removeEventListener('message', handler);
  }, { name: key, match: expected });
  timer = setTimeout(() => finish(undefined, new Error(`Timed out waiting for ${expected.type} ${expected.targetId}/${expected.documentEpoch}/${expected.sequence}`)), timeout);
  return { promise, dispose };
}

export async function observeIframeLoad(page: Page, selector: string, timeout = T.medium) {
  const frame = page.locator(selector).first();
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  let settled = false;
  const key = `__manualEditFrameLoad${Math.random().toString(36).slice(2)}`;
  const dispose = async () => {
    clearTimeout(timer);
    await frame.evaluate((node, name) => {
      const cleanup = (node as unknown as Record<string, (() => void) | undefined>)[name];
      cleanup?.();
      delete (node as unknown as Record<string, unknown>)[name];
    }, key).catch(() => undefined);
  };
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    void dispose();
    if (error) reject(error);
    else resolve();
  };
  const timer = setTimeout(() => finish(new Error(`Timed out waiting for iframe load: ${selector}`)), timeout);
  await page.exposeBinding(key, () => finish());
  await frame.evaluate((node, name) => {
    const handler = () => void (window as unknown as Record<string, () => void>)[name]?.();
    node.addEventListener('load', handler);
    (node as unknown as Record<string, () => void>)[name] = () => node.removeEventListener('load', handler);
  }, key);
  return { promise, dispose };
}

/** Playwright removes the response listener after resolution or timeout. Arm before Save. */
export function waitForSaveResponse(page: Page, projectId: string, timeout = T.medium): Promise<Response> {
  return page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/projects/${projectId}/files`, { timeout });
}
