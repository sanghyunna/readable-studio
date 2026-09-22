import { useState } from 'react';
import { Button } from '@readable-studio/components';
import { useT } from '../i18n';
import type { ChatMessage } from '../types';
import { RollbackModal } from './RollbackModal';

export function NativeWriteConflictNotice({ error, projectId, conversationId, message, onRestored }: {
  readonly error: Error;
  readonly projectId: string;
  readonly conversationId: string;
  readonly message: ChatMessage;
  readonly onRestored: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const details = 'details' in error ? error.details : null;
  if (!details || typeof details !== 'object'
    || !('kind' in details) || details.kind !== 'native-overwrite'
    || !('checkpointId' in details) || typeof details.checkpointId !== 'string') return null;
  const sidecar = 'sidecar' in details && typeof details.sidecar === 'string' ? details.sidecar : null;
  return <>
    {sidecar ? <code>{sidecar}</code> : null}
    <Button onClick={() => setOpen(true)}>{t('rollback.confirmFiles')}</Button>
    {open ? <RollbackModal projectId={projectId} conversationId={conversationId} targetMessage={message}
      initialMode="files_only" initialCheckpointId={details.checkpointId}
      onClose={() => setOpen(false)} onSuccess={() => { setOpen(false); onRestored(); }} /> : null}
  </>;
}
