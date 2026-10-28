import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Button } from '@readable-studio/components';
import type { DesignTemplateSummary } from '@readable-studio/contracts';
import { useT } from '../i18n';
import { Icon, type IconName } from './Icon';
import styles from './MentionPreviewPicker.module.css';

export interface MentionPreviewItem {
  key: string;
  id: string;
  kind: string;
  title: string;
  description: string;
  source?: string;
  kindLabel: string;
  icon: IconName;
  selected?: boolean;
  disabled?: boolean;
  rowDecoration?: ReactNode;
  preview?: ReactNode;
  dimensions?: { width: number; height: number };
}

export interface MentionPreviewPickerProps {
  items: MentionPreviewItem[];
  tabs: Array<{ id: string; label: string }>;
  tab: string;
  onTabChange(tab: string): void;
  activeIndex: number;
  onActiveIndexChange(index: number): void;
  onConfirm(item: MentionPreviewItem): void;
  onClose(): void;
  query: string;
  scopeLabel: string;
  listboxId: string;
  busy?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

/** Arrow-key step over `total` rows; -1 means no active row yet (bare `@`), so the first step enters at either end. */
export function stepMentionIndex(index: number, total: number, step: 1 | -1): number {
  if (index < 0) return step > 0 ? 0 : total - 1;
  return (index + step + total) % total;
}

/** Browsing only changes the preview; the separate Use action commits a choice. */
export function MentionPreviewPicker({ items, tabs, tab, onTabChange, activeIndex, onActiveIndexChange, onConfirm, onClose, query, scopeLabel, listboxId, busy = false, loading = false, error, onRetry }: MentionPreviewPickerProps) {
  const t = useT();
  const results = useRef<HTMLDivElement>(null);
  // A negative index leaves the preview on its hint and hides the Use action.
  const active = items[Math.min(activeIndex, Math.max(0, items.length - 1))];
  // A row that lands under a resting pointer (the picker opens above the caret, a
  // keyboard step scrolls the list) gets mouseenter and sometimes a synthetic mousemove
  // at the same spot. That is not a choice, so only a mousemove at new coordinates
  // highlights; the first one after opening just records where the pointer is.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pointerMoved = (event: MouseEvent<HTMLElement>) => {
    const last = pointer.current;
    pointer.current = { x: event.clientX, y: event.clientY };
    return !!last && (last.x !== event.clientX || last.y !== event.clientY);
  };
  useEffect(() => {
    const row = results.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    row?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeIndex, active?.key]);
  return <section className={styles.picker} data-testid="mention-popover" aria-label={t('chat.mentionPreviewTitle')} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
      event.preventDefault(); onActiveIndexChange(stepMentionIndex(activeIndex, items.length, event.key === 'ArrowDown' ? 1 : -1));
    }
  }}>
    <div className={styles.heading}><strong>{t('chat.mentionPreviewTitle')}</strong><span>{scopeLabel}</span><Button variant="ghost" size="icon" aria-label={t('common.close')} onMouseDown={event => event.preventDefault()} onClick={onClose}><Icon name="close" size={14} /></Button></div>
    <div className={styles.tabs} role="tablist" aria-label={t('chat.mentionTabsAria')}>
      {tabs.map(item => <Button key={item.id} variant="ghost" role="tab" aria-selected={tab === item.id} className={styles.tab} onMouseDown={event => event.preventDefault()} onClick={() => onTabChange(item.id)}>{item.label}</Button>)}
    </div>
    <div className={styles.body}>
      <div className={styles.results} ref={results} id={listboxId} role="listbox" aria-label={t('chat.mentionTabsAria')} aria-busy={loading || undefined}>
        {loading && !items.length ? <div className={styles.status} role="status">{t('chat.mentionLoading')}</div> : null}
        {!loading && !error && !items.length ? <div className={styles.status}>{query ? t('chat.mentionNoResults', { query }) : t('chat.mentionSearchPrompt')}</div> : null}
        {items.map((item, index) => <Button key={item.key} id={`${listboxId}-option-${index}`} variant="ghost" role="option" aria-selected={index === activeIndex} className={styles.row} data-option-index={index} data-resource-kind={item.kind} data-resource-id={item.id} onMouseDown={event => event.preventDefault()} onMouseMove={event => { if (pointerMoved(event) && index !== activeIndex) onActiveIndexChange(index); }} onFocus={() => onActiveIndexChange(index)} onClick={() => onActiveIndexChange(index)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && active && !active.disabled) { event.preventDefault(); onConfirm(active); } }}>
          <span className={styles.icon}><Icon name={item.icon} size={15} /></span>
          <span className={styles.rowText}><strong>{item.title}</strong><span>{item.kindLabel}{item.selected ? ` · ${t('chat.mentionSelected')}` : ''}</span></span>
          {item.rowDecoration}
        </Button>)}
      </div>
      <div className={styles.detail} data-testid="mention-preview-detail" data-resource-kind={active?.kind} data-resource-id={active?.id}>
        {active ? <>
          <h3>{active.title}</h3>
          <span className={styles.source}>{[active.kindLabel, active.source].filter(Boolean).join(' · ')}</span>
          {active.preview ? <div className={styles.preview}>{active.preview}</div> : null}
          {active.dimensions && active.dimensions.width > 0 && active.dimensions.height > 0 ? <span className={styles.dimensions} data-testid="mention-preview-dimensions">{active.dimensions.width} × {active.dimensions.height}</span> : null}
          <p>{active.description || t('chat.mentionDescriptionUnavailable')}</p>
        </> : <span className={styles.status}>{t('chat.mentionPreviewPrompt')}</span>}
      </div>
    </div>
    {error ? <div className={styles.error} role="alert"><span>{error}</span>{onRetry ? <Button variant="ghost" onMouseDown={event => event.preventDefault()} onClick={onRetry}>{t('chat.mentionRetry')}</Button> : null}</div> : null}
    <div className={styles.footer}>
      <div className={styles.footerHint}><span>{t('chat.mentionKeyboardHint')}</span>{loading && items.length ? <span role="status">{t('chat.mentionLoading')}</span> : null}</div>
      {active ? <div className={styles.action}><Button variant="primary" data-testid="mention-preview-use" disabled={busy || active.disabled} aria-busy={busy || undefined} onMouseDown={event => event.preventDefault()} onClick={() => onConfirm(active)}>{t(busy ? 'chat.mentionApplying' : active.selected ? 'chat.mentionUseSelected' : 'chat.mentionUse')}</Button></div> : null}
    </div>
  </section>;
}

/** Covers are actual images, never HTML snippets or fabricated placeholder art. */
export function MentionCoverImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const t = useT();
  useEffect(() => setFailed(false), [src]);
  return failed ? <span className={styles.status}>{t('chat.mentionPreviewUnavailable')}</span> : <img className={styles.cover} src={src} alt={alt} onError={() => setFailed(true)} />;
}

export function MentionTemplatePreview({ template }: { template: DesignTemplateSummary }) {
  const t = useT();
  if (template.thumbnail?.status !== 'ready') return <span className={styles.status}>{t(template.thumbnail?.status === 'pending' ? 'chat.mentionLoading' : 'chat.mentionPreviewUnavailable')}</span>;
  return <MentionCoverImage src={`/api/design-templates/${encodeURIComponent(template.id)}/thumbnail?v=${encodeURIComponent(template.thumbnail.updatedAt)}`} alt={template.name} />;
}
