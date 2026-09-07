import { vi } from 'vitest';

// jsdom exposes getContext but reports it as unimplemented. Returning null
// matches the platform API's supported fallback without hiding component errors.
export function stubMissingCanvasContext() {
  return vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation((() => null) as HTMLCanvasElement['getContext']);
}
