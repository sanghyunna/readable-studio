// Mount once beside the persistent rail, outside routed/hidden surfaces.
// Every globally exposed action has a visible shell-owned result. Peek is a
// non-modal overlay: it neither navigates nor resizes the project workspace.

import { useT } from '../../i18n';
import { Toast } from '../Toast';
import { HubCommandPalette } from './HubCommandPalette';
import { HubInspector } from './HubInspector';
import styles from './HubRailOverlays.module.css';
import { useHubRail } from './HubRailContext';

/** How long a deleted session stays undoable before the daemon is told. */
export const HUB_DELETE_UNDO_MS = 6000;

export function HubRailOverlays() {
  const t = useT();
  const rail = useHubRail();
  const { pendingSessionDeletion } = rail;

  return (
    <>
      {rail.peeked ? (
        <div className={styles.inspector}>
          <HubInspector
            session={rail.peeked.session}
            projectName={rail.peeked.project.name}
            onOpen={rail.openPeekedSession}
            onClose={rail.closeInspector}
          />
        </div>
      ) : null}
      {rail.paletteOpen ? (
        <HubCommandPalette entries={rail.paletteEntries} onClose={rail.closePalette} />
      ) : null}
      {pendingSessionDeletion ? (
        <Toast
          message={t('hub.sessionDeleted', { name: pendingSessionDeletion.session.title })}
          ttlMs={HUB_DELETE_UNDO_MS}
          actionLabel={t('manualEdit.undo')}
          onAction={rail.undoPendingSessionDeletion}
          onDismiss={rail.commitPendingSessionDeletion}
        />
      ) : null}
    </>
  );
}
