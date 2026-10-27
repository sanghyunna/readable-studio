import { fireEvent } from '@testing-library/react';

const canonicalSnapshots = new WeakMap<HTMLIFrameElement, { srcdoc: string; source: string; capture: Window['postMessage'] }>();

/** Host fixtures inspect canonical snapshots; the real bridge suite checks DOM replay. */
export function trackManualEditCanonicalSource(frame: HTMLIFrameElement): void {
  const win = frame.contentWindow;
  if (!win) throw new Error('Missing preview window');
  const previous = win.postMessage;
  const forward = previous.bind(win);
  const existing = canonicalSnapshots.get(frame);
  if (existing?.capture === previous) return;
  const state = existing ?? { srcdoc: frame.srcdoc, source: frame.srcdoc, capture: previous };
  const capture: Window['postMessage'] = (message: unknown, origin?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'readable-edit-preview-source'
      && 'afterSource' in message && typeof message.afterSource === 'string') {
      state.srcdoc = frame.srcdoc;
      state.source = message.afterSource;
    }
    if (typeof origin === 'string') {
      if (transfer === undefined) forward(message, origin);
      else forward(message, origin, transfer);
    }
    else forward(message, origin);
  };
  state.capture = capture;
  canonicalSnapshots.set(frame, state);
  win.postMessage = capture;
}

export function manualEditCanonicalSource(frame: HTMLIFrameElement): string {
  trackManualEditCanonicalSource(frame);
  const state = canonicalSnapshots.get(frame)!;
  return state.srcdoc === frame.srcdoc ? state.source : frame.srcdoc;
}

/** Capture the shipped load handshake without replacing a fixture's message adapter. */
export function manualEditFrameEpoch(frame: HTMLIFrameElement): string {
  trackManualEditCanonicalSource(frame);
  const win = frame.contentWindow;
  if (!win) throw new Error('Missing preview window');
  const previous = win.postMessage;
  const forward = previous.bind(win);
  let epoch: string | undefined;
  win.postMessage = (message: unknown, origin?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'readable-edit-mode'
      && 'documentEpoch' in message && typeof message.documentEpoch === 'string') epoch = message.documentEpoch;
    if (typeof origin === 'string') {
      if (transfer === undefined) forward(message, origin);
      else forward(message, origin, transfer);
    }
    else forward(message, origin);
  };
  try { fireEvent.load(frame); } finally { win.postMessage = previous; }
  if (!epoch) throw new Error('Preview did not publish its document epoch');
  return epoch;
}

export function stampManualEditFrameMessage(frame: HTMLIFrameElement, message: object): object {
  return { documentEpoch: manualEditFrameEpoch(frame), ...message };
}
