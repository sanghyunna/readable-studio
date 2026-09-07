import { JSDOM as NativeJSDOM, VirtualConsole, type ConstructorOptions } from 'jsdom';
import { afterEach, expect, vi } from 'vitest';
import { setTimeout, clearTimeout } from 'node:timers';

const fixtures: JSDOM[] = [];

/** Real jsdom observers and scripts, with errors owned through window teardown. */
export class JSDOM extends NativeJSDOM {
  readonly errors: Error[] = [];
  private closed: Promise<void> | undefined;
  readonly loaded: Promise<void>;

  constructor(html: string, options: ConstructorOptions = {}) {
    const errors: Error[] = [];
    const virtualConsole = new VirtualConsole().forwardTo(console);
    virtualConsole.on('jsdomError', (error) => errors.push(error));
    super(html, { ...options, virtualConsole });
    this.errors = errors;
    this.loaded = new Promise<void>((resolve) => {
      if (this.window.document.readyState === 'complete') resolve();
      else this.window.addEventListener('load', () => resolve(), { once: true });
    });
    fixtures.push(this);
    const close = this.window.close.bind(this.window);
    this.window.close = () => {
      if (this.closed) return;
      // close() clears the body and deletes window.document without pagehide.
      // Subscribe first so assertions include callbacks from that final mutation.
      this.closed = new Promise<void>((resolve) => {
        const observer = new this.window.MutationObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(this.window.document.body, { childList: true });
      });
      close();
    };
  }

  async discover(): Promise<void> {
    await this.nextTargets(() => {
      this.window.dispatchEvent(new this.window.MessageEvent('message', {
        data: { type: 'readable-edit-mode', enabled: true },
      }));
    });
  }

  nextTargets(trigger: () => void): Promise<void> {
    const parent = this.window.parent;
    const postMessage = parent.postMessage;
    const forwardPostMessage = postMessage.bind(parent);
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        parent.postMessage = postMessage;
        reject(new Error('Bridge did not post targets'));
      }, 2_000);
      parent.postMessage = (message: unknown, targetOrigin: string | WindowPostMessageOptions = {}, transfer?: Transferable[]) => {
        if (typeof targetOrigin === 'string') forwardPostMessage(message, targetOrigin, transfer);
        else forwardPostMessage(message, targetOrigin);
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'readable-edit-targets') {
          clearTimeout(timeout);
          parent.postMessage = postMessage;
          resolve();
        }
      };
      trigger();
    });
  }

  nextMutation(trigger: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const observer = new this.window.MutationObserver(() => {
        clearTimeout(timeout);
        observer.disconnect();
        resolve();
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Fixture did not mutate'));
      }, 2_000);
      observer.observe(this.window.document.documentElement, { attributes: true, childList: true, subtree: true });
      trigger();
    });
  }

  async dispose(): Promise<void> {
    this.window.close();
    await this.closed;
    expect(this.errors).toEqual([]);
  }
}

afterEach(async () => {
  try {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
}, 5_000);
