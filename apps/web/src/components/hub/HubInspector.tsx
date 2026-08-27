// Session inspector - the rail's "peek" surface.
//
// Peeking must never navigate: the panel answers "what is this session?" from
// the data the tree already has, and only the explicit open action hands off to
// the workspace. Escape closes it and returns focus to the row that opened it,
// which is what makes Space-to-peek usable from the keyboard.

import { useLayoutEffect } from 'react';

import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { relativeTimeShort } from './relativeTime';
import type { HubSessionNode, HubSessionState } from './types';

interface Props {
  session: HubSessionNode;
  projectName: string;
  onOpen: (session: HubSessionNode) => void;
  onClose: () => void;
}

const STATE_KEY: Record<HubSessionState, 'hub.stateRunning' | 'hub.stateAwaiting' | 'hub.stateFailed' | 'hub.stateDone'> = {
  running: 'hub.stateRunning',
  awaiting: 'hub.stateAwaiting',
  failed: 'hub.stateFailed',
  idle: 'hub.stateDone',
};

export function HubInspector({ session, projectName, onOpen, onClose }: Props) {
  const t = useT();

  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape belongs to the topmost dismissible thing. A row menu opens ON TOP
      // of the inspector, so while one is up it closes first - and it lives in a
      // body portal, where a React stopPropagation cannot shield this listener.
      if (document.querySelector('.hub-menu')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mode = session.sessionMode === 'chat' ? t('hub.modeChat') : t('hub.modeDesign');

  return (
    <aside
      className="hub-inspector"
      aria-label={t('hub.inspectorTitle')}
      data-testid="hub-inspector"
      tabIndex={-1}
    >
      <header className="hub-inspector__head">
        <span className="hub-inspector__eyebrow">{t('hub.inspectorTitle')}</span>
        <button
          type="button"
          className="hub-inspector__close"
          data-testid="hub-inspector-close"
          aria-label={t('hub.inspectorClose')}
          onClick={onClose}
        >
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="hub-inspector__body">
        <h2 className="hub-inspector__name" data-testid="hub-inspector-name">
          {session.title}
        </h2>
        <p className="hub-inspector__sub" data-testid="hub-inspector-project">
          {projectName}
        </p>

        <dl className="hub-inspector__facts">
          <dt>{t('hub.inspectorState')}</dt>
          <dd data-testid="hub-inspector-state">{t(STATE_KEY[session.state])}</dd>
          <dt>{t('hub.inspectorMode')}</dt>
          <dd>{mode}</dd>
          {session.messageCount === undefined ? null : (
            <>
              <dt>{t('hub.inspectorMessages')}</dt>
              <dd className="hub-inspector__num">{session.messageCount}</dd>
            </>
          )}
          <dt>{t('hub.inspectorLastActivity')}</dt>
          <dd className="hub-inspector__num">{relativeTimeShort(session.updatedAt, t)}</dd>
        </dl>

        <button
          type="button"
          className="hub-inspector__open"
          data-testid="hub-inspector-open"
          onClick={() => onOpen(session)}
        >
          {t('hub.inspectorOpen')}
        </button>
      </div>
    </aside>
  );
}
