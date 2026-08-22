import { useEffect, useState } from 'react';
import { Button } from '@readable-studio/components';
import { parseTranslate } from '../edit-mode/resize-geometry';
import type { ManualEditStyles, ManualEditTarget } from '../edit-mode/types';
import { useT } from '../i18n';
import { stripPxUnit } from './ManualEditPanel';
import { RemixIcon } from './RemixIcon';
import styles from './ManualEditGeometryControls.module.css';

type Axis = 'width' | 'height';
type SizeMode = 'auto' | 'fixed' | 'fill';
const AXES: readonly Axis[] = ['width', 'height'];

export function ManualEditGeometryControls({
  target,
  styles: elementStyles,
  onStyleField,
  onStyleFields,
}: {
  target: ManualEditTarget;
  styles: ManualEditStyles;
  onStyleField: (key: keyof ManualEditStyles, value: string) => void;
  onStyleFields?: (styles: Partial<ManualEditStyles>) => void;
}) {
  const t = useT();
  const initialOffset = parseTranslate(elementStyles.translate);
  const [aspectLocked, setAspectLocked] = useState(true);
  const [directPosition, setDirectPosition] = useState(initialOffset.x !== 0 || initialOffset.y !== 0);
  const [modeOverrides, setModeOverrides] = useState<Partial<Record<Axis, SizeMode>>>({});
  const offset = parseTranslate(elementStyles.translate);
  useEffect(() => {
    // A fresh authored-size object is the iframe's authoritative post-apply
    // answer. Drop optimistic modes even when the winning value stayed the
    // same because a stylesheet !important declaration rejected the change.
    setModeOverrides({});
  }, [target.id, target.authoredSize]);
  useEffect(() => {
    // Canvas drags update the inspector draft from outside this component.
    // Promote the position mode when a committed translate arrives so the
    // controls never keep claiming the object is still "With content".
    if (offset.x !== 0 || offset.y !== 0) setDirectPosition(true);
  }, [offset.x, offset.y]);

  const applyUpdates = (updates: Partial<ManualEditStyles>) => {
    if (onStyleFields) {
      onStyleFields(updates);
      return;
    }
    Object.entries(updates).forEach(([key, value]) => {
      onStyleField(key as keyof ManualEditStyles, value);
    });
  };

  const setSizeMode = (axis: Axis, mode: SizeMode) => {
    setModeOverrides((current) => ({ ...current, [axis]: mode }));
    if (mode === 'auto') onStyleField(axis, 'auto');
    else if (mode === 'fill') onStyleField(axis, '100%');
    else onStyleField(axis, fixedAxisValue(target, elementStyles, axis));
  };
  const setDimension = (axis: Axis, raw: string) => {
    const value = emitPxValue(raw);
    setModeOverrides((current) => ({ ...current, [axis]: sizeMode(value) }));
    const updates: Partial<ManualEditStyles> = { [axis]: value };
    if (!aspectLocked) {
      applyUpdates(updates);
      return;
    }
    const number = parseNumericPx(value);
    const ratio = targetAspectRatio(target);
    if (number === undefined || ratio === undefined) {
      applyUpdates(updates);
      return;
    }
    const other: Axis = axis === 'width' ? 'height' : 'width';
    if ((modeOverrides[other] ?? targetSizeMode(target, elementStyles, other)) !== 'fixed') {
      applyUpdates(updates);
      return;
    }
    const paired = axis === 'width' ? number / ratio : number * ratio;
    updates[other] = `${roundSize(paired)}px`;
    applyUpdates(updates);
  };
  const setOffset = (axis: 'x' | 'y', raw: string) => {
    const numeric = parseNumericInput(raw);
    if (numeric === undefined) return;
    const next = {
      ...offset,
      [axis]: numeric,
    };
    onStyleField('translate', `${formatOffset(next.x)}px ${formatOffset(next.y)}px`);
  };

  return (
    <div className={styles.root}>
      <h3 className={styles.subheading}>{t('manualEdit.geometry.sizing')}</h3>
      <div className={styles.axes}>
        {AXES.map((axis) => {
          const label = t(axis === 'width' ? 'manualEdit.shape.width' : 'manualEdit.shape.height');
          const mode = modeOverrides[axis] ?? targetSizeMode(target, elementStyles, axis);
          return (
            <div className={styles.axis} key={axis}>
              <span className={styles.axisName}>
                <RemixIcon name={axis === 'width' ? 'expand-width-line' : 'expand-height-line'} size={15} />
                {label}
              </span>
              <label className={styles.dimension}>
                <input
                  aria-label={label}
                  inputMode="decimal"
                  value={mode === 'fixed' ? fixedAxisDisplayValue(target, elementStyles, axis) : ''}
                  placeholder={mode === 'auto' ? t('manualEdit.geometry.auto') : '100'}
                  onChange={(event) => setDimension(axis, event.currentTarget.value)}
                />
                <em>px</em>
              </label>
              <div className={styles.segment} role="group" aria-label={`${label} ${t('manualEdit.geometry.modes')}`}>
                {(['auto', 'fixed', 'fill'] as const).map((option) => {
                  const optionLabel = t(`manualEdit.geometry.${option}`);
                  return (
                    <Button
                      key={option}
                      variant="subtle"
                      className={`${styles.segmentButton}${mode === option ? ` ${styles.active}` : ''}`}
                      aria-label={`${optionLabel} ${label}`}
                      aria-pressed={mode === option}
                      onClick={() => setSizeMode(axis, option)}
                    >
                      {optionLabel}
                    </Button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <Button
        variant="subtle"
        className={`${styles.aspect}${aspectLocked ? ` ${styles.active}` : ''}`}
        aria-label={t('manualEdit.geometry.keepAspect')}
        aria-pressed={aspectLocked}
        onClick={() => setAspectLocked((locked) => !locked)}
      >
        <RemixIcon name={aspectLocked ? 'link' : 'link-unlink'} size={14} />
        {t('manualEdit.geometry.keepAspect')}
      </Button>

      <h3 className={styles.subheading}>{t('manualEdit.geometry.position')}</h3>
      <div className={`${styles.segment} ${styles.positionModes}`} role="group" aria-label={t('manualEdit.geometry.position')}>
        <Button
          variant="subtle"
          className={`${styles.segmentButton}${!directPosition ? ` ${styles.active}` : ''}`}
          aria-label={t('manualEdit.geometry.inFlow')}
          aria-pressed={!directPosition}
          onClick={() => {
            setDirectPosition(false);
            onStyleField('translate', '');
          }}
        >
          {t('manualEdit.geometry.inFlow')}
        </Button>
        <Button
          variant="subtle"
          className={`${styles.segmentButton}${directPosition ? ` ${styles.active}` : ''}`}
          aria-label={t('manualEdit.geometry.directMove')}
          aria-pressed={directPosition}
          onClick={() => setDirectPosition(true)}
        >
          {t('manualEdit.geometry.directMove')}
        </Button>
      </div>
      <div className={styles.positionState}>
        <RemixIcon name={directPosition ? 'drag-move-2-line' : 'layout-row-line'} size={18} />
        <span>
          <strong>{t(directPosition ? 'manualEdit.geometry.directTitle' : 'manualEdit.geometry.flowTitle')}</strong>
          <small>{t(directPosition ? 'manualEdit.geometry.directHelp' : 'manualEdit.geometry.flowHelp')}</small>
        </span>
      </div>
      {directPosition ? (
        <div className={styles.offsets}>
          <OffsetInput
            label={t('manualEdit.geometry.offsetX')}
            shortLabel="X"
            value={offset.x}
            onChange={(value) => setOffset('x', value)}
          />
          <OffsetInput
            label={t('manualEdit.geometry.offsetY')}
            shortLabel="Y"
            value={offset.y}
            onChange={(value) => setOffset('y', value)}
          />
          <Button
            variant="subtle"
            size="icon"
            className={styles.resetPosition}
            aria-label={t('manualEdit.geometry.resetPosition')}
            title={t('manualEdit.geometry.resetPosition')}
            onClick={() => onStyleField('translate', '')}
          >
            <RemixIcon name="restart-line" size={14} />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function OffsetInput({
  label,
  shortLabel,
  value,
  onChange,
}: {
  label: string;
  shortLabel: string;
  value: number;
  onChange: (value: string) => void;
}) {
  const formatted = formatOffset(value);
  const [draft, setDraft] = useState(formatted);
  useEffect(() => setDraft(formatted), [formatted]);
  return (
    <label className={styles.offset}>
      <span>{shortLabel}</span>
      <input
        aria-label={label}
        inputMode="decimal"
        value={draft}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          if (parseNumericInput(next) !== undefined) onChange(next);
        }}
        onBlur={() => {
          if (parseNumericInput(draft) === undefined) setDraft(formatted);
        }}
      />
      <em>px</em>
    </label>
  );
}

export function sizeMode(value: string): SizeMode {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'auto';
  if (normalized === '100%') return 'fill';
  return 'fixed';
}

function targetSizeMode(
  target: ManualEditTarget,
  styles: ManualEditStyles,
  axis: Axis,
): SizeMode {
  if (target.authoredSize) return sizeMode(target.authoredSize[axis]);
  return sizeMode(styles[axis]);
}

function emitPxValue(raw: string): string {
  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
  if (/^-?\d+(\.\d+)?px$/i.test(trimmed)) return trimmed.toLowerCase();
  return raw;
}

function parseNumericPx(value: string): number | undefined {
  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(value.trim());
  if (!match?.[1]) return undefined;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fixedAxisValue(target: ManualEditTarget, styles: ManualEditStyles, axis: Axis): string {
  if (parseNumericPx(styles[axis]) !== undefined) return styles[axis];
  const computed = target.cssSize?.[axis];
  if (computed && parseNumericPx(computed) !== undefined) return computed;
  const scale = target.rectScale?.[axis === 'width' ? 'x' : 'y'] ?? 1;
  const rectSize = target.rect[axis] / (scale > 0 ? scale : 1);
  return `${roundSize(rectSize)}px`;
}

function fixedAxisDisplayValue(target: ManualEditTarget, styles: ManualEditStyles, axis: Axis): string {
  return stripPxUnit(fixedAxisValue(target, styles, axis));
}

function parseNumericInput(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function targetAspectRatio(target: ManualEditTarget): number | undefined {
  const width = parseNumericPx(target.cssSize?.width ?? '')
    ?? target.rect.width / (target.rectScale?.x || 1);
  const height = parseNumericPx(target.cssSize?.height ?? '')
    ?? target.rect.height / (target.rectScale?.y || 1);
  if (!(width > 0 && height > 0)) return undefined;
  return width / height;
}

function roundSize(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatOffset(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
