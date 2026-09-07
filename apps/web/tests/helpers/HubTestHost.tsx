// Explicit test-only shell. Production never creates a fallback rail owner.
import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { HubHome } from '../../src/components/hub/HubHome';
import { HubRail, type HubRailProps } from '../../src/components/hub/HubRail';
import { HubRailProvider } from '../../src/components/hub/HubRailContext';
import { HubRailOverlays } from '../../src/components/hub/HubRailOverlays';
import { useHubRailController, type HubRailControllerInputs } from '../../src/components/hub/useHubRailController';

export function HubTestHost({ children, ...props }: HubRailControllerInputs & HubRailProps & { children: ReactNode }) {
  const rail = useHubRailController(props);
  return (
    <HubRailProvider value={rail}>
      <div className="workspace-shell__body" style={{ '--hub-rail-expanded': `${rail.railWidth}px` } as CSSProperties}>
        <HubRail {...props} />
        <div data-surface="hub">{children}</div>
        <HubRailOverlays />
      </div>
    </HubRailProvider>
  );
}

export function TestHubHome(props: ComponentProps<typeof HubHome>) {
  return (
    <HubTestHost {...props} currentSessionId={props.currentSessionId ?? null}>
      <HubHome {...props} />
    </HubTestHost>
  );
}
