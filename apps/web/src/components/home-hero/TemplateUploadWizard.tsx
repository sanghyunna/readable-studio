import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input, ToggleCard, VisuallyHidden } from '@readable-studio/components';
import type { DesignTemplateUploadPage, UserDesignTemplateSummary } from '@readable-studio/contracts';
import { useT } from '../../i18n';
import { useEscapeDismiss } from '../../hooks/useEscapeDismiss';
import { Icon } from '../Icon';
import { useTemplateUpload } from './useTemplateUpload';
import styles from './TemplateUploadWizard.module.css';

export function TemplateUploadWizard({ onComplete, onClose }: {
  onComplete: (template: UserDesignTemplateSummary) => void;
  onClose: () => void;
}) {
  const t = useT();
  const upload = useTemplateUpload(onComplete);
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const id = useId();
  const stepNames = [
    t('homeHero.uploadStepType'), t('homeHero.uploadStepFile'),
    t('homeHero.uploadStepPages'), t('homeHero.uploadStepFinish'),
  ];
  const isSaving = upload.busy === 'finalizing';
  async function close() {
    if (isSaving || closing) return;
    setClosing(true);
    try { await upload.cancel(); onClose(); } catch {
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
  useEffect(() => { heading.current?.focus(); }, [upload.step]);
  const canContinue = upload.step === 1 ? upload.type !== null
    : upload.step === 2 ? upload.file !== null
    : upload.analysis !== null && upload.name.trim().length > 0 && upload.name.trim().length <= 120
      && upload.analysis.pages.some((page) => page.id === upload.coverPageId);
  const cover = upload.analysis?.pages.find((page) => page.id === upload.coverPageId);
  const typeLabel = upload.type === 'deck' ? t('homeHero.templateTabDeck')
    : upload.type === 'report' ? t('homeHero.templateTabReport') : t('homeHero.templateTabPrototype');

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
            aria-current={upload.step === index + 1 ? 'step' : undefined}
            className={upload.step === index + 1 ? styles.currentStep : undefined}>
            <span className={styles.stepNumber} aria-hidden="true">{index < upload.step - 1 ? <Icon name="check" size={14} /> : index + 1}</span>
            <span>{label}</span>
          </li>)}
        </ol>
        <p className={styles.privacy}>{t('homeHero.uploadPrivate')}</p>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow} aria-live="polite">{t('homeHero.uploadStepCount', { step: upload.step })}</p>
            <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{stepNames[upload.step - 1]}</h2>
          </div>
          <Button variant="ghost" size="icon" aria-label={t('homeHero.uploadClose')}
            disabled={isSaving || closing} onClick={() => void close()}><Icon name="close" size={18} /></Button>
        </header>
        <div className={styles.content}>
          {upload.step === 1 && <>
            <p className={styles.description}>{t('homeHero.uploadTypeHint')}</p>
            <div className={styles.types}>
              {(['deck', 'report', 'website'] as const).map((type) => <ToggleCard key={type}
                pressed={upload.type === type} onPressedChange={() => upload.setType(type)}
                className={styles.typeCard}
                aria-label={t(type === 'deck' ? 'homeHero.templateTabDeck' : type === 'report' ? 'homeHero.templateTabReport' : 'homeHero.templateTabPrototype')}>
                <Icon name={type === 'deck' ? 'present' : type === 'report' ? 'file' : 'palette'} size={28} />
                <strong>{t(type === 'deck' ? 'homeHero.templateTabDeck' : type === 'report' ? 'homeHero.templateTabReport' : 'homeHero.templateTabPrototype')}</strong>
                <span>{t(type === 'deck' ? 'homeHero.uploadDeckHint' : type === 'report' ? 'homeHero.uploadReportHint' : 'homeHero.uploadWebsiteHint')}</span>
              </ToggleCard>)}
            </div>
          </>}
          {upload.step === 2 && <>
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
          {upload.step === 3 && (upload.analysis ? <>
            <div className={styles.nameField}>
              <label htmlFor={`${id}-name`}>{t('homeHero.userTemplateName')}</label>
              <Input id={`${id}-name`} value={upload.name} maxLength={120}
                onChange={(event) => upload.setName(event.target.value)} />
            </div>
            <div className={styles.pagesHeading}>
              <div><h3>{t('homeHero.uploadCoverTitle')}</h3><p>{t('homeHero.uploadCoverHint')}</p></div>
              <span>{t('homeHero.uploadPageCount', { count: upload.analysis.pages.length })}</span>
            </div>
            <p className={styles.detected}><Icon name="check" size={14} />{upload.analysis.prompt.file}</p>
            <div className={styles.pages}>
              {upload.analysis.pages.map((page) => <ToggleCard key={page.id}
                className={styles.pageCard} pressed={upload.coverPageId === page.id}
                onPressedChange={() => upload.setCoverPageId(page.id)}
                aria-label={`${page.file}${upload.coverPageId === page.id ? ` · ${t('homeHero.uploadSelectedCover')}` : ''}`}
                data-testid="template-upload-page">
                <UploadPagePreview page={page} />
                <span className={styles.pageName}>{page.file}</span>
                {upload.coverPageId === page.id && <span className={styles.coverBadge}>{t('homeHero.uploadSelectedCover')}</span>}
              </ToggleCard>)}
            </div>
          </> : <div className={styles.loading} role="status" aria-live="polite">
            <Icon name="upload" size={32} />
            <h3>{t(upload.busy === 'uploading' ? 'homeHero.uploadUploading' : 'homeHero.uploadAnalysing')}</h3>
            {upload.busy === 'uploading' && <><progress max={100} value={upload.progress} aria-label={t('homeHero.uploadUploading')} /><span>{upload.progress}%</span></>}
            <p>{t('homeHero.uploadAnalyseHint')}</p>
          </div>)}
          {upload.step === 4 && <>
            <p className={styles.description}>{t('homeHero.uploadFinishHint')}</p>
            <div className={styles.summary}>
              {cover && <div className={styles.summaryPreview}><UploadPagePreview page={cover} /></div>}
              <h3>{upload.name.trim()}</h3>
              <dl>
                <dt>{t('homeHero.uploadStepType')}</dt><dd>{typeLabel}</dd>
                <dt>{t('homeHero.uploadCoverTitle')}</dt><dd>{cover?.file}</dd>
                <dt>{t('homeHero.uploadStepPages')}</dt><dd>{t('homeHero.uploadPageCount', { count: upload.analysis?.pages.length ?? 0 })}</dd>
              </dl>
            </div>
          </>}
          {upload.error && <p className={styles.error} role="alert">{t(
            upload.error === 'invalidFile' ? 'homeHero.uploadInvalidFile'
              : upload.error === 'expired' ? 'homeHero.uploadExpired'
                : upload.error === 'networkError' ? 'homeHero.uploadNetworkError'
                  : upload.error === 'saveError' ? 'homeHero.uploadSaveError' : 'homeHero.uploadAnalyseError',
          )}</p>}
        </div>
        <footer className={styles.footer}>
          <Button variant="ghost" disabled={isSaving || closing} onClick={() => void close()}>{t('homeHero.uploadCancel')}</Button>
          <div>
            {upload.step > 1 && <Button disabled={isSaving || closing} onClick={() => {
              if (upload.busy) void upload.cancel().then(() => { upload.setStep(2); });
              else upload.setStep((upload.step - 1) as 1 | 2 | 3);
            }}>{t('homeHero.uploadBack')}</Button>}
            <Button variant="primary" disabled={isSaving || closing || upload.busy !== null || !canContinue}
              onClick={() => {
                if (upload.step === 4) void upload.finish();
                else if (upload.step === 2) upload.analyse();
                else upload.setStep((upload.step + 1) as 2 | 4);
              }}>{t(isSaving ? 'homeHero.uploadSaving' : upload.step === 4 ? 'homeHero.uploadComplete' : 'homeHero.uploadNext')}</Button>
          </div>
        </footer>
      </div>
    </div>
  </div>, document.body);
}

function UploadPagePreview({ page }: { page: DesignTemplateUploadPage }) {
  const t = useT();
  const node = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(0);
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
  return <span ref={node} className={styles.preview} aria-hidden="true">
    {page.thumbnail.status === 'ready' && !failed
      ? <img src={page.thumbnailUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
      : visible ? <iframe src={page.previewUrl} title={page.file} sandbox="" tabIndex={-1} loading="lazy"
        width={1920} height={1080} style={{ transform: `scale(${previewWidth / 1920})` }} />
        : <Icon name="file" size={28} />}
    <VisuallyHidden>{t('homeHero.uploadCoverTitle')}</VisuallyHidden>
  </span>;
}
