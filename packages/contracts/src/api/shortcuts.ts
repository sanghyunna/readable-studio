export type ShortcutLocation = 'desktop' | 'startMenu';
export type ShortcutCapabilities = {
  desktop: boolean;
  startMenu: boolean;
  taskbar: false;
  startPinned: false;
  reason?: 'unsupported' | 'desktop-unavailable';
};
export type ShortcutCreateResult =
  | { status: 'created' | 'already-existed'; location: ShortcutLocation }
  | { status: 'failed'; location: ShortcutLocation; reason: 'unsupported' | 'desktop-unavailable' | 'conflict' | 'write-failed' | string };
