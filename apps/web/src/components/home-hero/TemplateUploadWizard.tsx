import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input, ToggleCard, VisuallyHidden } from '@readable-studio/components';
import type {
  DesignTemplateUploadPage, UploadableDesignTemplateType, UserDesignTemplateSummary,
} from '@readable-studio/contracts';
import { useI18n, useT } from '../../i18n';
import { localizeSkillName } from '../../i18n/content';
import type { Dict } from '../../i18n/types';
import { useEscapeDismiss } from '../../hooks/useEscapeDismiss';
import { Icon } from '../Icon';
import { useTemplateUpload, type UploadError } from './useTemplateUpload';
import styles from './TemplateUploadWizard.module.css';

const ERROR_KEYS: Record<UploadError, keyof Dict> = {
  invalidFile: 'homeHero.uploadInvalidFile',
  expired: 'homeHero.uploadExpired',
  networkError: 'homeHero.uploadNetworkError',
  saveError: 'homeHero.uploadSaveError',
  analyseError: 'homeHero.uploadAnalyseError',
};
// The summary's action is Retry, not Finish.
const SUMMARY_ERROR_KEYS: Record<UploadError, keyof Dict> = { ...ERROR_KEYS, saveError: 'homeHero.uploadSummarySaveError' };
const TYPE_KEYS: Record<UploadableDesignTemplateType, keyof Dict> = {
  deck: 'homeHero.templateTabDeck',
  report: 'homeHero.templateTabReport',
};

export function TemplateUploadWizard({ onComplete, onClose }: {
  onComplete: (templates: UserDesignTemplateSummary[]) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const upload = useTemplateUpload(onComplete);
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const id = useId();
  const stepNames = [t('homeHero.uploadStepFile'), t('homeHero.uploadStepPages'), t('homeHero.uploadStepFinish')];
  const isSaving = upload.busy === 'finalizing';
  async function close() {
    if (isSaving || closing) return;
    setClosing(true);
    try {
      if (upload.saved.length) {
        // Saved templates are committed, so cleanup is best effort here: the
        // daemon's sliding expiry sweeps any unfinalized children left behind.
        await upload.cancel().catch(() => {});
        onComplete(upload.saved);
      } else {
        await upload.cancel();
        onClose();
      }
    } catch {
      upload.setError('networkError');
      setClosing(false);
    }
  }
  useEscapeDismiss(() => { void close(); });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const siblings = Array.from(document.body.children).filter((node) => node !== dialog.current?.parentElement);
    const inert = siblings.map((node) => node.hasAttribute('inert'));
    siblings.forEach((node) => node.setAttribute('inert', ''));
    document.body.style.overflow = 'hidden';
    heading.current?.focus();
    return () => {
      siblings.forEach((node, index) => { if (!inert[index]) node.removeAttribute('inert'); });
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  useEffect(() => { heading.current?.focus(); }, [upload.step, upload.index, upload.summary]);
  // The outcome of the last summary retry: announced politely, and it moves focus
  // because a saved row (with the focused Retry button) leaves the list.
  const [retried, setRetried] = useState<{ position: number; text: string } | null>(null);
  async function retry(position: number, entryName: string) {
    setRetried(null);
    const result = await upload.retry(position);
    if (!result) return;
    setRetried({ position, text: typeof result === 'string'
      ? `${entryName}: ${t(SUMMARY_ERROR_KEYS[result])}` : t('homeHero.uploadRetrySaved', { name: entryName }) });
  }
  useEffect(() => {
    if (!retried) return;
    // Its own Retry when it failed again, else the next one left, else the heading.
    const buttons = Array.from(dialog.current?.querySelectorAll<HTMLElement>('[data-retry]') ?? []);
    (buttons.find((node) => Number(node.dataset.retry) >= retried.position) ?? buttons.at(-1) ?? heading.current)?.focus();
  }, [retried]);
  const item = upload.current;
  const isBundle = upload.bundle !== null;
  const isLast = upload.index === upload.items.length - 1;
  const canContinue = upload.step === 1 ? upload.file !== null
    : item !== undefined && item.name.trim().length > 0 && item.name.trim().length <= 120
      && item.analysis.pages.some((page) => page.id === item.coverPageId);
  const cover = item?.analysis.pages.find((page) => page.id === item.coverPageId);
  // Older daemons send no detection; finalize then falls back to deck as well.
  const resolvedType = item?.type ?? item?.analysis.detection?.type ?? item?.analysis.detectedType ?? 'deck';
  const reached = upload.summary ? 4 : upload.step;
  const skipped = upload.items.filter((entry) => entry.status === 'skipped');
  const failed = upload.items.flatMap((entry, position) => entry.status === 'failed' ? [{ entry, position }] : []);
  const invalid = upload.bundle?.invalid ?? [];

  return createPortal(<div className={styles.backdrop} onMouseDown={(event) => {
    if (event.target === event.currentTarget) void close();
  }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`} className={styles.dialog}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]):not([hidden]), [tabindex="0"]',
        ));
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}><Icon name="upload" size={20} />{t('homeHero.uploadTitle')}</div>
        <p id={`${id}-description`} className={styles.intro}>{t('homeHero.uploadIntro')}</p>
        <ol className={styles.steps}>
          {stepNames.map((label, index) => <li key={label}
            aria-current={reached === index + 1 ? 'step' : undefined}
            className={reached === index + 1 ? styles.currentStep : undefined}>
            <span className={styles.stepNumber} aria-hidden="true">{index < reached - 1 ? <Icon name="check" size={14} /> : index + 1}</span>
            <span>{label}</span>
          </li>)}
        </ol>
        <p className={styles.privacy}>{t('homeHero.uploadPrivate')}</p>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.header}>
          <div>
            {!upload.summary && <p className={styles.eyebrow} aria-live="polite">{t('homeHero.uploadStepCount', { step: upload.step })}</p>}
            {/* Mounted empty before the analysis lands: screen readers skip a live
                region that is inserted together with its text. */}
            {!upload.summary && upload.step > 1 && <p className={styles.progress} aria-live="polite"
              data-testid="template-upload-progress">
              {isBundle && item && <>
                {t('homeHero.uploadTemplateProgress', { current: upload.index + 1, total: upload.items.length })}
                <span className={styles.entryName}>{item.entryName}</span>
              </>}
            </p>}
            <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
              {upload.summary ? t('homeHero.uploadSummaryTitle') : stepNames[upload.step - 1]}
            </h2>
          </div>
          <Button variant="ghost" size="icon" aria-label={t('homeHero.uploadClose')}
            disabled={isSaving || closing} onClick={() => void close()}><Icon name="close" size={18} /></Button>
        </header>
        <div className={styles.content}>
          {upload.step === 1 && !upload.summary && <>
            <p className={styles.description}>{t('homeHero.uploadFileHint')}</p>
            <div className={`${styles.dropzone}${dragging ? ` ${styles.dragging}` : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault(); setDragging(false);
                void upload.selectFiles(Array.from(event.dataTransfer.files));
              }}>
              <Icon name={upload.file ? 'file' : 'upload'} size={32} />
              <strong>{upload.file?.name ?? t('homeHero.uploadDrop')}</strong>
              <span>{upload.file ? t('homeHero.uploadFileReady') : t('homeHero.uploadZipOnly')}</span>
              <Button onClick={() => fileInput.current?.click()}>{t(upload.file ? 'homeHero.uploadReplace' : 'homeHero.uploadChooseFile')}</Button>
              <Input ref={fileInput} hidden type="file" accept=".zip" data-testid="template-upload-file"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void upload.selectFiles(files);
                }} />
            </div>
            <p className={styles.note}>{t('homeHero.uploadStructureHint')}</p>
          </>}
          {upload.step === 2 && !upload.summary && (item ? <>
            <div className={styles.nameField}>
              <label htmlFor={`${id}-name`}>{t('homeHero.userTemplateName')}</label>
              <Input id={`${id}-name`} value={item.name} maxLength={120}
                onChange={(event) => upload.update({ name: event.target.value })} />
            </div>
            <div className={styles.pagesHeading}>
              <div><h3>{t('homeHero.uploadCoverTitle')}</h3><p>{t('homeHero.uploadCoverHint')}</p></div>
              <span>{t('homeHero.uploadPageCount', { count: item.analysis.pages.length })}</span>
            </div>
            <p className={styles.detected}><Icon name="check" size={14} />{item.analysis.prompt.file}</p>
            <div className={styles.pages}>
              {item.analysis.pages.map((page) => <ToggleCard key={page.id}
                className={styles.pageCard} pressed={item.coverPageId === page.id}
                onPressedChange={() => upload.update({ coverPageId: page.id })}
                aria-label={`${page.file}${item.coverPageId === page.id ? ` · ${t('homeHero.uploadSelectedCover')}` : ''}`}
                data-testid="template-upload-page">
                <UploadPagePreview page={page} />
                <span className={styles.pageName}>{page.file}</span>
                {item.coverPageId === page.id && <span className={styles.coverBadge}>{t('homeHero.uploadSelectedCover')}</span>}
              </ToggleCard>)}
            </div>
          </> : <div className={styles.loading} role="status" aria-live="polite">
            <Icon name="upload" size={32} />
            <h3>{t(upload.busy === 'uploading' ? 'homeHero.uploadUploading' : 'homeHero.uploadAnalysing')}</h3>
            {upload.busy === 'uploading' && <><progress max={100} value={upload.progress} aria-label={t('homeHero.uploadUploading')} /><span>{upload.progress}%</span></>}
            <p>{t('homeHero.uploadAnalyseHint')}</p>
          </div>)}
          {upload.step === 3 && item && <>
            <p className={styles.description}>{t('homeHero.uploadFinishHint')}</p>
            <div className={styles.summary}>
              {cover && <div className={styles.summaryPreview}><UploadPagePreview page={cover} /></div>}
              <h3>{item.name.trim()}</h3>
              <dl>
                <dt>{t('homeHero.uploadDetectedType')}</dt>
                <dd data-testid="template-upload-detected-type">{t(TYPE_KEYS[resolvedType])}</dd>
                <dt>{t('homeHero.uploadCoverTitle')}</dt><dd>{cover?.file}</dd>
                <dt>{t('homeHero.uploadStepPages')}</dt><dd>{t('homeHero.uploadPageCount', { count: item.analysis.pages.length })}</dd>
              </dl>
              {item.analysis.detection?.ambiguous && <TypeChoice key={item.analysis.sessionId}
                value={resolvedType} chosen={item.type !== undefined} onChange={(type) => upload.update({ type })} />}
            </div>
          </>}
          {upload.summary && <div className={styles.results} data-testid="template-upload-summary">
            {upload.saved.length > 0 && <section>
              <h3>{t('homeHero.uploadSummarySaved', { count: upload.saved.length })}</h3>
              <ul>{upload.saved.map((template) => <li key={template.id}><strong>{localizeSkillName(locale, template)}</strong></li>)}</ul>
            </section>}
            {skipped.length > 0 && <section>
              <h3>{t('homeHero.uploadSummarySkipped', { count: skipped.length })}</h3>
              <ul>{skipped.map((entry) => <li key={entry.analysis.sessionId}><strong>{entry.entryName}</strong></li>)}</ul>
            </section>}
            {failed.length > 0 && <section>
              <h3>{t('homeHero.uploadSummaryFailed', { count: failed.length })}</h3>
              <ul>{failed.map(({ entry, position }) => <li key={entry.analysis.sessionId}>
                <div><strong>{entry.name.trim()}</strong> <span>{entry.entryName}</span>
                  <p>{t(SUMMARY_ERROR_KEYS[entry.error ?? 'saveError'])}</p></div>
                <Button disabled={upload.busy !== null || closing} data-retry={position}
                  aria-label={`${t('homeHero.uploadRetry')}: ${entry.entryName}`}
                  onClick={() => void retry(position, entry.entryName)}>{t('homeHero.uploadRetry')}</Button>
              </li>)}</ul>
            </section>}
            {invalid.length > 0 && <section>
              <h3>{t('homeHero.uploadSummaryInvalid', { count: invalid.length })}</h3>
              <ul>{invalid.map((entry) => <li key={entry.entryName}>
                <div><strong>{entry.entryName}</strong><p>{entry.reason}</p></div>
              </li>)}</ul>
            </section>}
            <VisuallyHidden role="status">{retried?.text}</VisuallyHidden>
          </div>}
          {upload.error && <p className={styles.error} role="alert">
            {t(ERROR_KEYS[upload.error])}
            {upload.errorDetail && <span className={styles.errorDetail}>{upload.errorDetail}</span>}
          </p>}
        </div>
        <footer className={styles.footer}>
          {!upload.summary && <Button variant="ghost" disabled={isSaving || closing} onClick={() => void close()}>{t('homeHero.uploadCancel')}</Button>}
          <div>
            {!upload.summary && upload.step > 1 && !(isBundle && upload.step === 2 && upload.index > 0)
              && <Button disabled={isSaving || closing} onClick={() => {
                if (upload.busy) void upload.cancel().then(() => { upload.setStep(1); });
                else upload.setStep((upload.step - 1) as 1 | 2);
              }}>{t('homeHero.uploadBack')}</Button>}
            {isBundle && !upload.summary && upload.step > 1 && <Button disabled={upload.busy !== null || closing}
              onClick={upload.skip}>{t('homeHero.uploadSkip')}</Button>}
            <Button variant="primary"
              disabled={isSaving || closing || (!upload.summary && (upload.busy !== null || !canContinue))}
              onClick={() => {
                if (upload.summary) void close();
                else if (upload.step === 3) void upload.finish();
                else if (upload.step === 1) upload.analyse();
                else upload.setStep(3);
              }}>{t(upload.summary ? 'homeHero.uploadDone'
                : isSaving ? 'homeHero.uploadSaving'
                  : upload.step < 3 ? 'homeHero.uploadNext'
                    : isBundle && !isLast ? 'homeHero.uploadSaveNext' : 'homeHero.uploadComplete')}</Button>
          </div>
        </footer>
      </div>
    </div>
  </div>, document.body);
}

// Shown only for an ambiguous detection: a two-option radio group that
// overrides the detected type, announcing the choice politely.
function TypeChoice({ value, chosen, onChange }: {
  value: UploadableDesignTemplateType;
  chosen: boolean;
  onChange: (type: UploadableDesignTemplateType) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(chosen);
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const types = ['deck', 'report'] as const;
  return <div className={styles.typeChoice}>
    <p>{t('homeHero.uploadTypeAmbiguous')}</p>
    {open ? <div role="radiogroup" aria-label={t('homeHero.uploadDetectedType')} className={styles.typeOptions}>
      {types.map((type, position) => <button key={type} type="button" role="radio"
        ref={(node) => { options.current[position] = node; }}
        aria-checked={value === type} tabIndex={value === type ? 0 : -1} autoFocus={value === type}
        className={styles.typeOption} onClick={() => onChange(type)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          // Two options: every arrow key moves to the other one.
          onChange(types[1 - position]!);
          options.current[1 - position]?.focus();
        }}>{t(TYPE_KEYS[type])}</button>)}
    </div> : <Button onClick={() => setOpen(true)}>{t('homeHero.uploadChangeType')}</Button>}
    {open && <p role="status" className={styles.typeStatus}>
      {chosen ? t('homeHero.uploadTypeChanged', { type: t(TYPE_KEYS[value]) }) : ''}
    </p>}
  </div>;
}

function UploadPagePreview({ page }: { page: DesignTemplateUploadPage }) {
  const t = useT();
  const node = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(0);
  const { width, height } = page.viewport ?? { width: 1920, height: 1080 };
  useEffect(() => {
    const target = node.current;
    if (!target) return;
    const measure = () => setPreviewWidth(target.clientWidth);
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!node.current || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(node.current);
    return () => observer.disconnect();
  }, []);
  return <span ref={node} className={styles.preview} aria-hidden="true" style={{ aspectRatio: `${width} / ${height}` }}>
    {page.thumbnail.status === 'ready' && !failed
      ? <img src={page.thumbnailUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
      : visible ? <iframe src={page.previewUrl} title={page.file} sandbox="" tabIndex={-1} loading="lazy"
        width={width} height={height} style={{ transform: `scale(${previewWidth / width})` }} />
        : <Icon name="file" size={28} />}
    <VisuallyHidden>{t('homeHero.uploadCoverTitle')}</VisuallyHidden>
  </span>;
}
