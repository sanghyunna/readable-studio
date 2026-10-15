import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input } from '@readable-studio/components';
import { HubMenu } from '../hub/HubMenu';
import { Icon } from '../Icon';
import { useT } from '../../i18n';

export function UserDeckTemplateControls({ name, onManage }: {
  name: string;
  onManage: (name?: string) => Promise<boolean>;
}) {
  const t = useT();
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [action, setAction] = useState<'rename' | 'delete' | null>(null);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (busy) return;
    setBusy(true);
    if (await onManage(action === 'rename' ? draft.trim() : undefined)) setAction(null);
    setBusy(false);
  }
  return <>
    <Button ref={trigger} variant="ghost" className="home-hero__user-template-menu"
      aria-label={t('homeHero.userTemplateManage')} aria-haspopup="menu" aria-expanded={menu}
      onClick={() => setMenu((current) => !current)}>
      <Icon name="more-horizontal" size={16} />
    </Button>
    {menu ? <HubMenu title={name} anchor={trigger.current} onClose={() => setMenu(false)}
      items={[
        { id: 'rename', kind: 'action', label: t('homeHero.userTemplateRename'), onSelect: () => { setDraft(name); setAction('rename'); setMenu(false); } },
        { id: 'delete', kind: 'action', label: t('homeHero.userTemplateDelete'), danger: true, onSelect: () => { setAction('delete'); setMenu(false); } },
      ]} /> : null}
    {action ? createPortal(
      <div className="modal-backdrop" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setAction(null); }}>
        <section className="modal home-hero__user-template-dialog" role="dialog" aria-modal="true"
          aria-label={t(action === 'rename' ? 'homeHero.userTemplateRename' : 'homeHero.userTemplateDelete')}>
          <h3>{t(action === 'rename' ? 'homeHero.userTemplateRename' : 'homeHero.userTemplateDelete')}</h3>
          {action === 'rename' ? <Input autoFocus aria-label={t('homeHero.userTemplateName')} value={draft}
            onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && draft.trim()) void save(); }} />
            : <p>{t('homeHero.userTemplateDeleteConfirm', { name })}</p>}
          <div className="home-hero__user-template-dialog-actions">
            <Button variant="ghost" disabled={busy} onClick={() => setAction(null)}>{t('homeHero.userTemplateCancel')}</Button>
            <Button disabled={busy || (action === 'rename' && !draft.trim())} onClick={() => void save()}>
              {t(action === 'rename' ? 'homeHero.userTemplateSave' : 'homeHero.userTemplateDelete')}
            </Button>
          </div>
        </section>
      </div>, document.body,
    ) : null}
  </>;
}
