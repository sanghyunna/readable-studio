// "Open work" - the sessions currently held open, above the project tree.
//
// This is the rail's answer to a tab bar: the same list the tree already
// renders, filtered to what the user has open, with a close action per row. It
// is client-side session state, not daemon state - closing a row puts the
// session away, it does not delete anything.

import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { initialGlyph } from './initialGlyph';

export interface HubOpenWorkItem {
  sessionId: string;
  projectId: string;
  title: string;
  projectName: string;
}

interface Props {
  items: HubOpenWorkItem[];
  currentSessionId: string | null;
  onOpen: (item: HubOpenWorkItem) => void;
  onClose: (item: HubOpenWorkItem) => void;
}

export function HubOpenWork({ items, currentSessionId, onOpen, onClose }: Props) {
  const t = useT();
  if (items.length === 0) return null;

  return (
    <section className="hub-open" aria-label={t('hub.openWork')} data-testid="hub-open-work">
      <p className="hub-open__label">{t('hub.openWork')}</p>
      {items.map((item) => (
        <div
          key={item.sessionId}
          className={`hub-row hub-row--open${
            item.sessionId === currentSessionId ? ' is-current' : ''
          }`}
          role="button"
          tabIndex={0}
          data-testid={`hub-open-work-${item.sessionId}`}
          data-initial={initialGlyph(item.title)}
          // The collapsed rail hides the title, so the row's name has to come
          // from an attribute rather than from its (display:none) contents.
          aria-label={`${item.projectName} · ${item.title}`}
          title={`${item.projectName} · ${item.title}`}
          onClick={() => onOpen(item)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onOpen(item);
          }}
        >
          <span className="hub-row__title">{item.title}</span>
          <span className="hub-row__actions">
            <button
              type="button"
              className="hub-row__action"
              data-testid={`hub-close-open-${item.sessionId}`}
              aria-label={t('hub.closeOpenWork', { name: item.title })}
              onClick={(event) => {
                event.stopPropagation();
                onClose(item);
              }}
            >
              <Icon name="close" size={13} />
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}
