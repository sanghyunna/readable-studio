'use client';

import { useSyncExternalStore } from 'react';
import { isLowSpecProfile, subscribePerformanceProfile } from './config';

export function useLowSpecProfile(): boolean {
  return useSyncExternalStore(subscribePerformanceProfile, isLowSpecProfile, () => false);
}
