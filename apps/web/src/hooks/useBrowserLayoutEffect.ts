import { useEffect, useLayoutEffect } from 'react';

// Layout effects preserve pre-paint browser behavior, but React warns when they
// are rendered on the server because there is no layout phase there.
export const useBrowserLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;
