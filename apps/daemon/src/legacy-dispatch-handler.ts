import type { IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Dispatcher } from 'undici';

type LegacyHandler = {
  readonly onConnect: (abort: (error: Error) => void, context: unknown) => void;
  readonly onError: (error: Error) => void;
  readonly onHeaders?: (status: number, headers: string[], resume: () => void, statusText?: string) => boolean;
  readonly onData?: (chunk: Buffer) => boolean;
  readonly onComplete?: (trailers: string[]) => void;
  readonly onUpgrade?: (status: number, headers: string[], socket: Duplex) => void;
  readonly onBodySent?: (chunk: Buffer) => void;
  readonly onRequestSent?: () => void;
};

function rawHeaders(headers: IncomingHttpHeaders): string[] {
  return Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : Array.isArray(value) ? value.flatMap(item => [name, item]) : [name, value]);
}

/** Node 24's built-in fetch still supplies Undici's pre-v8 dispatch callbacks. */
export function compatibleDispatchHandler(handler: Dispatcher.DispatchHandler | LegacyHandler): Dispatcher.DispatchHandler {
  if (!('onConnect' in handler)) return handler;
  return {
    onRequestStart(controller, context: unknown) {
      handler.onConnect(error => controller.abort(error), context);
    },
    onResponseStart(controller, status, headers, statusText) {
      if (handler.onHeaders?.(status, rawHeaders(headers), () => controller.resume(), statusText) === false) controller.pause();
    },
    onResponseData(controller, chunk) {
      if (handler.onData?.(chunk) === false) controller.pause();
    },
    onResponseEnd(_controller, trailers) { handler.onComplete?.(rawHeaders(trailers)); },
    onResponseError(_controller, error) { handler.onError(error); },
    onRequestUpgrade(_controller, status, headers, socket) { handler.onUpgrade?.(status, rawHeaders(headers), socket); },
    onBodySent(chunk) { handler.onBodySent?.(chunk); },
    onRequestSent() { handler.onRequestSent?.(); },
  };
}
