// AppInner supplies ONE controller to the persistent rail, its overlays and
// Home's start surface. A consumer outside that provider is a wiring error;
// isolated tests must opt into an explicit test host.

import { createContext, useContext, type ReactNode } from 'react';

import type { HubRailController } from './useHubRailController';

const HubRailContext = createContext<HubRailController | null>(null);

export function HubRailProvider({
  value,
  children,
}: {
  value: HubRailController;
  children: ReactNode;
}) {
  return <HubRailContext.Provider value={value}>{children}</HubRailContext.Provider>;
}

export function useHubRail(): HubRailController {
  const controller = useContext(HubRailContext);
  if (!controller) {
    throw new Error('useHubRail() requires a HubRailProvider above it');
  }
  return controller;
}
