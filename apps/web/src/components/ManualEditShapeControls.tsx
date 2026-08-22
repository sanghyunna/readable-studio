// Shape/box controls for a selected element, shared between the horizontal
// docked toolbar (`layout="bar"`) and the vertical left-panel inspector
// (`layout="stack"`). Whole-element style edits go through onStyleField; image
// replace and delete go through onApplyPatch.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, VisuallyHidden } from '@readable-studio/components';
import { useT } from '../i18n';
import type { ManualEditPatch, ManualEditResizeConstraint, ManualEditStyles, ManualEditTarget } from '../edit-mode/types';
import { RemixIcon } from './RemixIcon';
import {
  BORDER_STYLE_OPTS,
  DIRECTION_OPTS,
  EDITOR_SWATCH_COLORS,
  ITEMS_OPTS,
  JUSTIFY_OPTS,
  normalizeColorForPicker,
  stripPxUnit,
} from './ManualEditPanel';
import {
  ActionRow,
  ColorRow,
  DisclosureSection,
  NumberRow,
  QuadField,
  SelectRow,
} from './ManualEditInspectorRows';
import { ManualEditBoxModelControls } from './ManualEditBoxModelControls';
import { ManualEditGeometryControls, sizeMode } from './ManualEditGeometryControls';
import styles from './ManualEditShapeControls.module.css';

export interface ManualEditShapeControlsProps {
  layout: 'bar' | 'stack';
  target: ManualEditTarget;
  styles: ManualEditStyles;
  draftAlt: string;
  error?: string | null;
  resizeConstraints?: readonly ManualEditResizeConstraint[];
  announceResizeConstraints?: boolean;
  busy?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  getActiveTarget?: () => ManualEditTarget | null;
  onStyleField: (key: keyof ManualEditStyles, value: string) => void;
  onStyleFields?: (styles: Partial<ManualEditStyles>) => void;
  onApplyPatch: (patch: ManualEditPatch, label: string) => void;
  onPickImage?: (file: File) => Promise<string | null>;
  onError: (message: string) => void;
  onUndo: () => void;
  onRedo: () => void;
}

export function ManualEditShapeControls(props: ManualEditShapeControlsProps) {
  return props.layout === 'stack' ? <ShapeStack {...props} /> : <ShapeBar {...props} />;
}

// Horizontal docked bar. Markup preserved from the original
// ManualEditShapeToolbar so its behaviour/tests round-trip unchanged.
function ShapeBar({
  target,
  styles: elementStyles,
  draftAlt,
  error,
  resizeConstraints,
  announceResizeConstraints,
  busy,
  canUndo,
  canRedo,
  getActiveTarget,
  onStyleField,
  onApplyPatch,
  onPickImage,
  onError,
  onUndo,
  onRedo,
}: ManualEditShapeControlsProps) {
  const t = useT();
  const [uploadingImage, setUploadingImage] = useState(false);
  const [confirmDeleteTargetId, setConfirmDeleteTargetId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setConfirmDeleteTargetId(null);
  }, [target.id]);
  const update = (key: keyof ManualEditStyles, value: string) => onStyleField(key, value);
  const confirmingDelete = confirmDeleteTargetId === target.id;

  return (
    <>
      <ResizeFeedback constraints={resizeConstraints} layout="bar" announce={announceResizeConstraints} />
      <div className={styles.group}>
        <Button variant="subtle" size="icon" aria-label={t('manualEdit.undo')} title={t('manualEdit.undo')} disabled={busy || !canUndo} onClick={onUndo}>
          <RemixIcon name="arrow-go-back-line" size={15} />
        </Button>
        <Button variant="subtle" size="icon" aria-label={t('manualEdit.redo')} title={t('manualEdit.redo')} disabled={busy || !canRedo} onClick={onRedo}>
          <RemixIcon name="arrow-go-forward-line" size={15} />
        </Button>
      </div>

      <span className={styles.divider} aria-hidden="true" />

      <div className={styles.group}>
        <ColorControl label={t('manualEdit.shape.fill')} value={elementStyles.backgroundColor} onChange={(v) => update('backgroundColor', v)} />
        <UnitInput label={t('manualEdit.shape.width')} icon="expand-width-line" value={elementStyles.width} unit="px" autoUnit compact onChange={(v) => update('width', v)} />
        <UnitInput label={t('manualEdit.shape.height')} icon="expand-height-line" value={elementStyles.height} unit="px" autoUnit compact onChange={(v) => update('height', v)} />
      </div>

      <span className={styles.divider} aria-hidden="true" />

      <div className={`${styles.group} ${styles.menuGroup}`}>
        <ToolbarPopover label={t('manualEdit.shape.spacing')} icon="box-3-line">
          <Quad label={t('manualEdit.shape.padding')} sideLabels={{
            t: t('manualEdit.shape.paddingTop'),
            r: t('manualEdit.shape.paddingRight'),
            b: t('manualEdit.shape.paddingBottom'),
            l: t('manualEdit.shape.paddingLeft'),
          }} values={{
            t: elementStyles.paddingTop, r: elementStyles.paddingRight, b: elementStyles.paddingBottom, l: elementStyles.paddingLeft,
          }} onChange={(side, value) => update(sideToProp('padding', side), value)} />
          <Quad label={t('manualEdit.shape.margin')} sideLabels={{
            t: t('manualEdit.shape.marginTop'),
            r: t('manualEdit.shape.marginRight'),
            b: t('manualEdit.shape.marginBottom'),
            l: t('manualEdit.shape.marginLeft'),
          }} values={{
            t: elementStyles.marginTop, r: elementStyles.marginRight, b: elementStyles.marginBottom, l: elementStyles.marginLeft,
          }} onChange={(side, value) => update(sideToProp('margin', side), value)} />
        </ToolbarPopover>

        <ToolbarPopover label={t('manualEdit.shape.border')} icon="rounded-corner">
          <div className={styles.popoverRow}>
            <SelectControl label={t('manualEdit.shape.style')} value={elementStyles.borderStyle} options={BORDER_STYLE_OPTS} onChange={(v) => update('borderStyle', v)} compact />
            <ColorControl label={t('manualEdit.shape.borderColor')} value={elementStyles.borderColor} onChange={(v) => update('borderColor', v)} />
          </div>
          <Quad label={t('manualEdit.shape.borderWidths')} sideLabels={{
            t: t('manualEdit.shape.borderWidthsTop'),
            r: t('manualEdit.shape.borderWidthsRight'),
            b: t('manualEdit.shape.borderWidthsBottom'),
            l: t('manualEdit.shape.borderWidthsLeft'),
          }} values={{
            t: elementStyles.borderTopWidth, r: elementStyles.borderRightWidth, b: elementStyles.borderBottomWidth, l: elementStyles.borderLeftWidth,
          }} onChange={(side, value) => update(`border${sideUpper(side)}Width` as keyof ManualEditStyles, value)} />
        </ToolbarPopover>
      </div>

      <div className={styles.group}>
        <UnitInput label={t('manualEdit.shape.radius')} icon="rounded-corner" value={elementStyles.borderRadius} unit="px" autoUnit compact onChange={(v) => update('borderRadius', v)} />
        <UnitInput label={t('manualEdit.shape.opacity')} icon="contrast-drop-2-line" value={elementStyles.opacity} unit="" compact onChange={(v) => update('opacity', v)} />
      </div>

      <span className={styles.divider} aria-hidden="true" />

      <div className={`${styles.group} ${styles.menuGroup}`}>

        {target.isLayoutContainer ? (
          <ToolbarPopover label={t('manualEdit.shape.layout')} icon="layout-row-line">
            <UnitInput label={t('manualEdit.shape.gap')} value={elementStyles.gap} unit="px" autoUnit onChange={(v) => update('gap', v)} />
            <SelectControl label={t('manualEdit.shape.direction')} value={elementStyles.flexDirection} options={DIRECTION_OPTS} onChange={(v) => update('flexDirection', v)} />
            <SelectControl label={t('manualEdit.shape.justify')} value={elementStyles.justifyContent} options={JUSTIFY_OPTS} onChange={(v) => update('justifyContent', v)} />
            <SelectControl label={t('manualEdit.shape.align')} value={elementStyles.alignItems} options={ITEMS_OPTS} onChange={(v) => update('alignItems', v)} />
          </ToolbarPopover>
        ) : null}

        <ToolbarPopover label={t('manualEdit.shape.more')} icon="more-2-line">
          {target.kind === 'image' && onPickImage ? (
            <>
              <button type="button" className={styles.menuAction} disabled={busy || uploadingImage} onClick={() => fileInputRef.current?.click()}>
                <RemixIcon name="image-add-line" size={14} />
                {uploadingImage ? t('manualEdit.uploadingImage') : t('manualEdit.uploadImage')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className={styles.fileInput}
                onChange={async (event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file) return;
                  event.currentTarget.value = '';
                  setUploadingImage(true);
                  try {
                    const src = await onPickImage(file);
                    const activeTarget = getActiveTarget?.() ?? target;
                    if (!src) {
                      onError(t('manualEdit.uploadImageFailed'));
                      return;
                    }
                    if (activeTarget?.id !== target.id || activeTarget.kind !== 'image') return;
                    onApplyPatch({
                      id: activeTarget.id,
                      kind: 'set-image',
                      src,
                      alt: draftAlt,
                    }, t('manualEdit.uploadImage'));
                  } finally {
                    setUploadingImage(false);
                  }
                }}
              />
            </>
          ) : null}
          {confirmingDelete ? (
            <div className={styles.confirmDelete}>
              <button
                type="button"
                className={styles.dangerAction}
                disabled={busy}
                aria-label={t('manualEdit.deleteElement')}
                onClick={() => {
                  if (confirmDeleteTargetId !== target.id) {
                    setConfirmDeleteTargetId(target.id);
                    return;
                  }
                  setConfirmDeleteTargetId(null);
                  onApplyPatch({ id: target.id, kind: 'remove-element' }, t('manualEdit.deleteElement'));
                }}
              >
                <RemixIcon name="delete-bin-line" size={14} />
                {t('manualEdit.deleteElement')}
              </button>
              <button type="button" className={styles.menuAction} disabled={busy} onClick={() => setConfirmDeleteTargetId(null)}>
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.dangerAction}
              aria-label={t('manualEdit.deleteElement')}
              disabled={busy}
              onClick={() => setConfirmDeleteTargetId(target.id)}
            >
              <RemixIcon name="delete-bin-line" size={14} />
              {t('manualEdit.deleteElement')}
            </button>
          )}
        </ToolbarPopover>
      </div>
      {error ? <div className={styles.error} role="alert" title={error}>{error}</div> : null}
    </>
  );
}

// Vertical inspector: common actions stay visible, precision groups fold by default.
function ShapeStack({
  target,
  styles: elementStyles,
  draftAlt,
  resizeConstraints,
  announceResizeConstraints,
  busy,
  getActiveTarget,
  onStyleField,
  onStyleFields,
  onApplyPatch,
  onPickImage,
  onError,
}: ManualEditShapeControlsProps) {
  const t = useT();
  const [uploadingImage, setUploadingImage] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const noFill = isNoFill(elementStyles.backgroundColor);
  const lastFillRef = useRef(noFill ? '#000000' : normalizeColorForPicker(elementStyles.backgroundColor));
  useEffect(() => {
    setConfirmingDelete(false);
  }, [target.id]);
  useEffect(() => {
    if (!isNoFill(elementStyles.backgroundColor)) {
      lastFillRef.current = normalizeColorForPicker(elementStyles.backgroundColor);
    }
  }, [elementStyles.backgroundColor]);
  const update = (key: keyof ManualEditStyles, value: string) => onStyleField(key, value);
  const isTextLike = target.kind === 'text'
    || target.kind === 'link'
    || target.kind === 'token'
    || !!target.textEditTargetId;
  const sizeSummary = `${dimensionSummary(elementStyles.width, target.authoredSize?.width, target.cssSize?.width, target.rect.width, t)} × ${dimensionSummary(elementStyles.height, target.authoredSize?.height, target.cssSize?.height, target.rect.height, t)}`;
  const spacingSummary = `${t('manualEdit.shape.padding')} ${compactSpace(elementStyles, 'padding')} · ${t('manualEdit.shape.margin')} ${compactSpace(elementStyles, 'margin')}`;
  const appearanceSummary = [noFill ? t('manualEdit.shape.noFill') : elementStyles.backgroundColor, elementStyles.borderRadius || '0px'].join(' · ');

  return (
    <div className={styles.stack}>
      {!isTextLike ? (
        <section className={`${styles.quickPanel} cc-section`}>
          <header className={`${styles.quickHeader} cc-section-head`}>
            <strong>{t('manualEdit.quickShape')}</strong>
            <span>{t('manualEdit.sectionShape')}</span>
          </header>
          <div className={`${styles.quickBody} cc-section-body`}>
            <div className={styles.quickGrid}>
              <QuickColorField
                icon="paint-fill"
                label={t('manualEdit.shape.fill')}
                value={elementStyles.backgroundColor}
                onChange={(value) => update('backgroundColor', value)}
              />
              <QuickColorField
                icon="pencil-ruler-2-line"
                label={t('manualEdit.shape.borderColor')}
                value={elementStyles.borderColor}
                onChange={(value) => update('borderColor', value)}
              />
            </div>
            <div className={styles.quickGrid}>
              <QuickValueField
                icon="rounded-corner"
                label={t('manualEdit.shape.radius')}
                value={stripPxUnit(elementStyles.borderRadius)}
                unit="px"
                onChange={(value) => update('borderRadius', emitUnitValue(value, 'px'))}
              />
              <QuickValueField
                icon="contrast-drop-line"
                label={t('manualEdit.shape.opacity')}
                value={opacityPercent(elementStyles.opacity)}
                unit="%"
                onChange={(value) => update('opacity', opacityValue(value))}
              />
            </div>
          </div>
        </section>
      ) : null}

      <ResizeFeedback constraints={resizeConstraints} layout="stack" announce={announceResizeConstraints} />

      <DisclosureSection
        title={t('manualEdit.sizePosition')}
        summary={sizeSummary}
        icon="aspect-ratio-line"
      >
        <ManualEditGeometryControls
          target={target}
          styles={elementStyles}
          onStyleField={onStyleField}
          onStyleFields={onStyleFields}
        />
      </DisclosureSection>

      <DisclosureSection
        title={t('manualEdit.groupSpacing')}
        summary={spacingSummary}
        icon="box-3-line"
      >
        <ManualEditBoxModelControls
          key={target.id}
          styles={elementStyles}
          onStyleField={onStyleField}
          onStyleFields={onStyleFields}
        />
      </DisclosureSection>

      <DisclosureSection
        title={t('manualEdit.groupAppearance')}
        summary={appearanceSummary}
        icon="palette-line"
      >
        <div className={styles.detailRows}>
        <div className={styles.fillField}>
          <ColorRow
            label={t('manualEdit.shape.fill')}
            description={t('manualEdit.shape.fillHelp')}
            value={noFill ? '' : elementStyles.backgroundColor}
            disabled={noFill}
            onChange={(value) => {
              lastFillRef.current = normalizeColorForPicker(value);
              update('backgroundColor', value);
            }}
          />
          <label className={styles.noFillToggle}>
            <input
              type="checkbox"
              checked={noFill}
              onChange={(event) => update('backgroundColor', event.currentTarget.checked ? 'transparent' : lastFillRef.current)}
            />
            <span>{t('manualEdit.shape.noFill')}</span>
          </label>
        </div>
        <NumberRow
          label={t('manualEdit.shape.radius')}
          description={t('manualEdit.shape.radiusHelp')}
          value={elementStyles.borderRadius}
          unit="px"
          autoUnit
          onChange={(v) => update('borderRadius', v)}
        />
        <NumberRow
          label={t('manualEdit.shape.opacity')}
          description={t('manualEdit.shape.opacityHelp')}
          value={opacityPercent(elementStyles.opacity)}
          unit="%"
          onChange={(v) => update('opacity', opacityValue(v))}
        />
        <div className={styles.detailDivider} />
        <SelectRow
          label={t('manualEdit.shape.style')}
          description={t('manualEdit.shape.styleHelp')}
          value={elementStyles.borderStyle}
          options={BORDER_STYLE_OPTS}
          onChange={(v) => update('borderStyle', v)}
        />
        <ColorRow
          label={t('manualEdit.shape.borderColor')}
          description={t('manualEdit.shape.borderColorHelp')}
          value={elementStyles.borderColor}
          onChange={(v) => update('borderColor', v)}
        />
        <QuadField
          label={t('manualEdit.shape.borderWidths')}
          description={t('manualEdit.shape.borderWidthsHelp')}
          sideLabels={{
            t: t('manualEdit.shape.borderWidthsTop'),
            r: t('manualEdit.shape.borderWidthsRight'),
            b: t('manualEdit.shape.borderWidthsBottom'),
            l: t('manualEdit.shape.borderWidthsLeft'),
          }}
          values={{ t: elementStyles.borderTopWidth, r: elementStyles.borderRightWidth, b: elementStyles.borderBottomWidth, l: elementStyles.borderLeftWidth }}
          onChange={(side, value) => update(`border${sideUpper(side)}Width` as keyof ManualEditStyles, value)}
        />
        {target.kind === 'image' && onPickImage ? (
          <>
            <ActionRow
              icon="image-add-line"
              label={uploadingImage ? t('manualEdit.uploadingImage') : t('manualEdit.uploadImage')}
              disabled={busy || uploadingImage}
              onClick={() => fileInputRef.current?.click()}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className={styles.fileInput}
              onChange={async (event) => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                event.currentTarget.value = '';
                setUploadingImage(true);
                try {
                  const src = await onPickImage(file);
                  const activeTarget = getActiveTarget?.() ?? target;
                  if (!src) {
                    onError(t('manualEdit.uploadImageFailed'));
                    return;
                  }
                  if (activeTarget?.id !== target.id || activeTarget.kind !== 'image') return;
                  onApplyPatch({ id: activeTarget.id, kind: 'set-image', src, alt: draftAlt }, t('manualEdit.uploadImage'));
                } finally {
                  setUploadingImage(false);
                }
              }}
            />
          </>
        ) : null}
        {confirmingDelete ? (
          <div className={styles.confirmDelete}>
            <ActionRow
              icon="delete-bin-line"
              label={t('manualEdit.deleteElement')}
              danger
              disabled={busy}
              onClick={() => {
                setConfirmingDelete(false);
                onApplyPatch({ id: target.id, kind: 'remove-element' }, t('manualEdit.deleteElement'));
              }}
            />
            <ActionRow
              icon="close-line"
              label={t('common.cancel')}
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
            />
          </div>
        ) : (
          <ActionRow
            icon="delete-bin-line"
            label={t('manualEdit.deleteElement')}
            danger
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          />
        )}
        </div>
      </DisclosureSection>

      {target.isLayoutContainer ? (
        <DisclosureSection
          title={t('manualEdit.groupLayout')}
          summary={[elementStyles.flexDirection || '—', elementStyles.gap || '0px'].join(' · ')}
          icon="layout-grid-line"
        >
          <div className={styles.detailRows}>
          <NumberRow
            label={t('manualEdit.shape.gap')}
            description={t('manualEdit.shape.gapHelp')}
            value={elementStyles.gap}
            unit="px"
            autoUnit
            onChange={(v) => update('gap', v)}
          />
          <SelectRow
            label={t('manualEdit.shape.direction')}
            description={t('manualEdit.shape.directionHelp')}
            value={elementStyles.flexDirection}
            options={DIRECTION_OPTS}
            onChange={(v) => update('flexDirection', v)}
          />
          <SelectRow
            label={t('manualEdit.shape.justify')}
            description={t('manualEdit.shape.justifyHelp')}
            value={elementStyles.justifyContent}
            options={JUSTIFY_OPTS}
            onChange={(v) => update('justifyContent', v)}
          />
          <SelectRow
            label={t('manualEdit.shape.align')}
            description={t('manualEdit.shape.alignHelp')}
            value={elementStyles.alignItems}
            options={ITEMS_OPTS}
            onChange={(v) => update('alignItems', v)}
          />
          </div>
        </DisclosureSection>
      ) : null}
    </div>
  );
}

function ResizeFeedback({
  constraints,
  layout,
  announce,
}: {
  constraints?: readonly ManualEditResizeConstraint[];
  layout: 'bar' | 'stack';
  announce?: boolean;
}) {
  const t = useT();
  if (!constraints?.length) return null;
  const messages = constraints.map((constraint) => {
    const axis = t(constraint.axis === 'width' ? 'manualEdit.shape.width' : 'manualEdit.shape.height');
    const hasNamedLimit = constraint.reason !== 'layout' && constraint.property && constraint.value;
    return {
      axis: constraint.axis,
      limit: hasNamedLimit
        ? t('manualEdit.resize.limit', { axis, property: constraint.property!, value: constraint.value! })
        : t('manualEdit.resize.layoutLimit', { axis }),
      measurements: t('manualEdit.resize.measurements', {
        requested: Math.round(constraint.requested),
        applied: Math.round(constraint.applied),
      }),
    };
  });
  return (
    <>
      <div className={`${styles.resizeFeedback} ${layout === 'bar' ? styles.resizeFeedbackBar : ''}`}>
        {messages.map((message) => (
          <div className={styles.resizeFeedbackLine} key={message.axis}>
            <span>{message.limit}</span>
            <span className={styles.resizeFeedbackMeasure}>{message.measurements}</span>
          </div>
        ))}
      </div>
      {announce ? (
        <VisuallyHidden role="status" aria-live="polite">
          {messages.map((message) => `${message.limit}. ${message.measurements}`).join(' ')}
        </VisuallyHidden>
      ) : null}
    </>
  );
}

function QuickColorField({
  icon,
  label,
  value,
  onChange,
}: {
  icon: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.quickField}>
      <RemixIcon name={icon} size={15} />
      <span className={styles.quickLabel}>{label}</span>
      <strong className={styles.quickValue}>{value || '—'}</strong>
      <ColorControl label={label} value={value} onChange={onChange} />
    </div>
  );
}

function QuickValueField({
  icon,
  label,
  value,
  unit,
  onChange,
}: {
  icon: string;
  label: string;
  value: string;
  unit: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.quickField}>
      <RemixIcon name={icon} size={15} />
      <span className={styles.quickLabel}>{label}</span>
      <input
        className={styles.quickInput}
        aria-label={label}
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <em className={styles.quickUnit}>{unit}</em>
    </label>
  );
}

function emitUnitValue(raw: string, unit: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return `${trimmed}${unit}`;
  return raw;
}

function isNoFill(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === 'transparent';
}

function opacityPercent(value: string): string {
  const numeric = parsePlainDecimal(value);
  if (numeric === undefined) return value;
  return String(Math.round(numeric * 10000) / 100);
}

function opacityValue(value: string): string {
  const numeric = parsePlainDecimal(value);
  if (numeric === undefined) return value;
  return String(Math.max(0, Math.min(100, numeric)) / 100);
}

function parsePlainDecimal(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return undefined;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function dimensionSummary(
  value: string,
  authoredValue: string | undefined,
  computed: string | undefined,
  rectValue: number,
  t: ReturnType<typeof useT>,
): string {
  const draftMode = sizeMode(value);
  const mode = draftMode === 'fixed' && authoredValue !== undefined
    ? sizeMode(authoredValue)
    : draftMode;
  if (mode === 'auto') {
    const measured = stripPxUnit(computed || `${Math.round(rectValue)}px`);
    return `${measured}px ${t('manualEdit.geometry.auto')}`;
  }
  if (mode === 'fill') return t('manualEdit.geometry.fill');
  const numericPx = /^(-?\d+(?:\.\d+)?)px$/i.exec(value.trim());
  if (!numericPx?.[1]) return value;
  return `${Math.round(Number.parseFloat(numericPx[1]) * 10) / 10}px`;
}

function compactSpace(elementStyles: ManualEditStyles, kind: 'padding' | 'margin'): string {
  const values = (['Top', 'Right', 'Bottom', 'Left'] as const).map((side) => (
    stripPxUnit(elementStyles[`${kind}${side}` as keyof ManualEditStyles] || '0px') || '0'
  ));
  if (values.every((value) => value === values[0])) return values[0]!;
  if (values[0] === values[2] && values[1] === values[3]) return `${values[0]}·${values[1]}`;
  return values.join('·');
}

function ToolbarPopover({ label, icon, children }: { label: string; icon: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [open]);
  return (
    <span className={styles.popoverWrap} ref={ref}>
      <Button
        variant="subtle"
        size="default"
        className={`${styles.popoverButton} readable-tooltip`}
        aria-label={label}
        aria-expanded={open}
        data-tooltip={label}
        onClick={() => setOpen((v) => !v)}
      >
        <RemixIcon name={icon} size={15} />
        <span>{label}</span>
        <RemixIcon name="arrow-down-s-line" size={14} />
      </Button>
      {open ? <div className={styles.popover} role="group" aria-label={label}>{children}</div> : null}
    </span>
  );
}

function UnitInput({
  label, icon, value, unit, autoUnit, compact, onChange,
}: {
  label: string;
  icon?: string;
  value: string;
  unit: 'px' | '';
  autoUnit?: boolean;
  compact?: boolean;
  onChange: (value: string) => void;
}) {
  const display = unit === 'px' ? stripPxUnit(value) : value;
  const emit = (raw: string) => {
    const trimmed = raw.trim();
    if (autoUnit && trimmed && /^-?\d+(\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
    if (autoUnit && /^-?\d+(\.\d+)?px$/i.test(trimmed)) return trimmed.toLowerCase();
    return raw;
  };
  return (
    <label
      className={`${styles.field}${compact ? ` ${styles.compactField}` : ''}${icon ? ' readable-tooltip' : ''}`}
      data-tooltip={icon ? label : undefined}
    >
      {icon ? <RemixIcon name={icon} size={14} /> : <span>{label}</span>}
      <input
        aria-label={label}
        value={display}
        inputMode="decimal"
        onChange={(event) => onChange(emit(event.currentTarget.value))}
      />
      {unit ? <em>{unit}</em> : null}
    </label>
  );
}

function SelectControl({
  label, value, options, onChange, compact,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<string>;
  onChange: (value: string) => void;
  compact?: boolean;
}) {
  return (
    <label className={`${styles.field} ${compact ? styles.compactField : ''}`}>
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {!options.includes(value) && value ? <option value={value}>{value}</option> : null}
        {options.map((option) => <option key={option || '__'} value={option}>{option || '-'}</option>)}
      </select>
    </label>
  );
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [open]);
  return (
    <span className={styles.colorWrap} ref={ref}>
      <button
        type="button"
        className={`${styles.swatch} readable-tooltip`}
        style={{ '--swatch-color': value || 'transparent' } as CSSProperties}
        aria-label={label}
        data-tooltip={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      />
      {open ? (
        <div className={styles.colorPopover}>
          <div className={styles.colorGrid}>
            {EDITOR_SWATCH_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                className={styles.colorTile}
                style={{ background: hex }}
                aria-label={hex}
                onClick={() => { onChange(hex); setOpen(false); }}
              />
            ))}
          </div>
          <input type="color" className={styles.colorNative} value={normalizeColorForPicker(value)} onChange={(event) => onChange(event.currentTarget.value)} />
        </div>
      ) : null}
    </span>
  );
}

function Quad({
  label, sideLabels, values, onChange,
}: {
  label: string;
  sideLabels: { t: string; r: string; b: string; l: string };
  values: { t: string; r: string; b: string; l: string };
  onChange: (side: 't' | 'r' | 'b' | 'l', value: string) => void;
}) {
  return (
    <div className={styles.quad}>
      <span className={styles.quadLabel}>{label}</span>
      <UnitInput label={sideLabels.t} value={values.t} unit="px" autoUnit onChange={(value) => onChange('t', value)} />
      <UnitInput label={sideLabels.r} value={values.r} unit="px" autoUnit onChange={(value) => onChange('r', value)} />
      <UnitInput label={sideLabels.b} value={values.b} unit="px" autoUnit onChange={(value) => onChange('b', value)} />
      <UnitInput label={sideLabels.l} value={values.l} unit="px" autoUnit onChange={(value) => onChange('l', value)} />
    </div>
  );
}

function sideToProp(base: 'padding' | 'margin', side: 't' | 'r' | 'b' | 'l'): keyof ManualEditStyles {
  return `${base}${sideUpper(side)}` as keyof ManualEditStyles;
}

function sideUpper(side: 't' | 'r' | 'b' | 'l'): 'Top' | 'Right' | 'Bottom' | 'Left' {
  return side === 't' ? 'Top' : side === 'r' ? 'Right' : side === 'b' ? 'Bottom' : 'Left';
}
