// Appearance body of the left-inspector Shape panel. Every property is carried
// by an icon or a control whose shape states its purpose (a swatch that IS the
// colour, a border-style row that draws the line styles, a box figure whose
// edges are the border widths), so the panel scans like PowerPoint's Format
// Shape pane instead of a list of sentences. Values and patch calls are the
// same as the previous row list: whole-element style edits go through
// onStyleField / onStyleFields.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ToggleButton } from '@readable-studio/components';
import { useT } from '../i18n';
import type { ManualEditStyles } from '../edit-mode/types';
import { RemixIcon } from './RemixIcon';
import { BORDER_STYLE_OPTS, normalizeColorForPicker, stripPxUnit } from './ManualEditPanel';
import { formatSteppedNumber, isNumericInput } from './ManualEditInspectorRows';
import { ManualEditColorPopover } from './ManualEditColorPopover';
import styles from './ManualEditAppearanceControls.module.css';

type Side = 'Top' | 'Right' | 'Bottom' | 'Left';
const SIDES: readonly Side[] = ['Top', 'Right', 'Bottom', 'Left'];
const borderWidthKey = (side: Side) => `border${side}Width` as keyof ManualEditStyles;

export function ManualEditAppearanceControls({
  styles: elementStyles,
  onStyleField,
  onStyleFields,
  children,
}: {
  styles: ManualEditStyles;
  onStyleField: (key: keyof ManualEditStyles, value: string) => void;
  onStyleFields?: (styles: Partial<ManualEditStyles>) => void;
  /** Element-level actions (image replace, delete) rendered in the separated action zone. */
  children?: ReactNode;
}) {
  const t = useT();
  const noFill = isNoFill(elementStyles.backgroundColor);
  const lastFillRef = useRef(noFill ? '#000000' : normalizeColorForPicker(elementStyles.backgroundColor));
  useEffect(() => {
    if (!isNoFill(elementStyles.backgroundColor)) {
      lastFillRef.current = normalizeColorForPicker(elementStyles.backgroundColor);
    }
  }, [elementStyles.backgroundColor]);
  const update = (key: keyof ManualEditStyles, value: string) => onStyleField(key, value);

  return (
    <div className={styles.root}>
      <PropertyGroup title={t('manualEdit.shape.groupSurface')}>
        <div className={styles.colorPair}>
          <ColorField
            icon="paint-fill"
            label={t('manualEdit.shape.fill')}
            value={noFill ? '' : elementStyles.backgroundColor}
            disabled={noFill}
            onChange={(value) => {
              lastFillRef.current = normalizeColorForPicker(value);
              update('backgroundColor', value);
            }}
            trailing={(
              <ToggleButton
                className={styles.noFill}
                pressed={noFill}
                aria-label={t('manualEdit.shape.noFill')}
                title={t('manualEdit.shape.noFill')}
                onPressedChange={(pressed) => update('backgroundColor', pressed ? 'transparent' : lastFillRef.current)}
              >
                <RemixIcon name="forbid-line" size={14} />
              </ToggleButton>
            )}
          />
          <ColorField
            icon="square-line"
            label={t('manualEdit.shape.borderColor')}
            value={elementStyles.borderColor}
            onChange={(value) => update('borderColor', value)}
          />
        </div>

        <BorderStyleField value={elementStyles.borderStyle} onChange={(value) => update('borderStyle', value)} />

        <BorderWidthField
          styles={elementStyles}
          onStyleField={onStyleField}
          onStyleFields={onStyleFields}
        />
      </PropertyGroup>

      <PropertyGroup title={t('manualEdit.shape.groupGeometry')}>
        <div className={styles.geometryPair}>
          <RadiusField value={elementStyles.borderRadius} onChange={(value) => update('borderRadius', value)} />
          <OpacityField value={elementStyles.opacity} onChange={(value) => update('opacity', value)} />
        </div>
      </PropertyGroup>

      {children ? (
        <div className={styles.actionZone} role="group" aria-label={t('manualEdit.shape.dangerZone')}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function PropertyGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group}>
      <h4 className={styles.groupTitle}>{title}</h4>
      <div className={styles.groupBody}>{children}</div>
    </section>
  );
}

// Colour: the swatch is the value. Hex/oklch text stays editable next to it.
// The picker itself is a body portal (ManualEditColorPopover) so the
// inspector's overflow boxes cannot clip it.
function ColorField({
  icon, label, value, disabled, onChange, trailing,
}: {
  icon: string;
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const swatchRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className={`${styles.field} ${styles.colorField}${disabled ? ` ${styles.fieldDisabled}` : ''}`}>
      <span className={styles.fieldIcon} title={label}><RemixIcon name={icon} size={15} /></span>
      <button
        ref={swatchRef}
        type="button"
        className={`${styles.swatch}${disabled ? ` ${styles.swatchEmpty}` : ''}`}
        style={{ '--swatch-color': disabled ? 'transparent' : value || 'transparent' } as CSSProperties}
        aria-label={`Pick ${label}`}
        aria-expanded={open}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      />
      <input
        className={styles.colorInput}
        value={value}
        placeholder={disabled ? '—' : '#000000'}
        aria-label={label}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {trailing}
      <ManualEditColorPopover
        open={open && !disabled}
        anchorRef={swatchRef}
        label={label}
        value={value}
        onChange={onChange}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

// Border style: each option draws its own line, so the row reads without the
// word "solid". Off-list authored values (e.g. `groove`) stay selectable so a
// pre-existing style is never silently dropped.
function BorderStyleField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  const names: Record<string, string> = {
    '': t('manualEdit.shape.borderStyleDefault'),
    solid: t('manualEdit.shape.borderStyleSolid'),
    dashed: t('manualEdit.shape.borderStyleDashed'),
    dotted: t('manualEdit.shape.borderStyleDotted'),
    double: t('manualEdit.shape.borderStyleDouble'),
    none: t('manualEdit.shape.borderStyleNone'),
  };
  const options = BORDER_STYLE_OPTS.includes(value) ? BORDER_STYLE_OPTS : [...BORDER_STYLE_OPTS, value];
  return (
    <div className={`${styles.field} ${styles.styleField}`} role="radiogroup" aria-label={t('manualEdit.shape.style')}>
      <span className={styles.fieldIcon} title={t('manualEdit.shape.style')}><RemixIcon name="pencil-ruler-2-line" size={15} /></span>
      <div className={styles.styleOptions}>
        {options.map((option) => {
          const selected = option === value;
          return (
            <button
              key={option || '__default'}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={names[option] ?? option}
              title={names[option] ?? option}
              tabIndex={selected || (!options.includes(value) && option === '') ? 0 : -1}
              className={`${styles.styleOption}${selected ? ` ${styles.styleOptionOn}` : ''}`}
              data-style={option || 'default'}
              onClick={() => onChange(option)}
              onKeyDown={(event) => {
                const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
                if (!delta) return;
                event.preventDefault();
                const index = options.indexOf(option);
                const next = options[(index + delta + options.length) % options.length]!;
                onChange(next);
                const nextButton = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                  `[data-style="${next || 'default'}"]`,
                );
                nextButton?.focus();
              }}
            >
              {option === 'none' ? (
                <RemixIcon name="forbid-line" size={14} />
              ) : option === '' ? (
                <RemixIcon name="subtract-line" size={14} />
              ) : (
                <span className={styles.styleLine} style={{ borderTopStyle: option } as CSSProperties} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Border widths: a box figure whose edges are the widths. Uniform mode (default
// when all four agree) edits every side through one input; per-side mode places
// an input on each edge of the figure.
function BorderWidthField({
  styles: elementStyles,
  onStyleField,
  onStyleFields,
}: {
  styles: ManualEditStyles;
  onStyleField: (key: keyof ManualEditStyles, value: string) => void;
  onStyleFields?: (styles: Partial<ManualEditStyles>) => void;
}) {
  const t = useT();
  const values = SIDES.map((side) => elementStyles[borderWidthKey(side)]);
  const uniform = values.every((value) => value === values[0]);
  const [linked, setLinked] = useState(uniform);
  const applyAll = (value: string) => {
    const updates = Object.fromEntries(SIDES.map((side) => [borderWidthKey(side), value])) as Partial<ManualEditStyles>;
    if (onStyleFields) {
      onStyleFields(updates);
      return;
    }
    SIDES.forEach((side) => onStyleField(borderWidthKey(side), value));
  };
  const sideLabels: Record<Side, string> = {
    Top: t('manualEdit.shape.borderWidthsTop'),
    Right: t('manualEdit.shape.borderWidthsRight'),
    Bottom: t('manualEdit.shape.borderWidthsBottom'),
    Left: t('manualEdit.shape.borderWidthsLeft'),
  };
  const figureStyle = {
    '--bw-top': previewWidth(elementStyles.borderTopWidth),
    '--bw-right': previewWidth(elementStyles.borderRightWidth),
    '--bw-bottom': previewWidth(elementStyles.borderBottomWidth),
    '--bw-left': previewWidth(elementStyles.borderLeftWidth),
  } as CSSProperties;

  return (
    <div className={`${styles.field} ${styles.widthField}`} role="group" aria-label={t('manualEdit.shape.borderWidths')}>
      <span className={styles.fieldIcon} title={t('manualEdit.shape.borderWidths')}><RemixIcon name="space" size={15} /></span>
      <div className={`${styles.widthFigure}${linked ? ` ${styles.widthFigureLinked}` : ''}`} style={figureStyle}>
        <span className={styles.widthBox} aria-hidden="true" />
        {linked ? (
          <NumericWell
            className={`${styles.widthInput} ${styles.widthInputAll}`}
            label={t('manualEdit.shape.borderWidthAll')}
            value={values[0] ?? ''}
            onChange={applyAll}
          />
        ) : SIDES.map((side) => (
          <NumericWell
            key={side}
            className={`${styles.widthInput} ${styles[`widthInput${side}`]}`}
            label={sideLabels[side]}
            value={elementStyles[borderWidthKey(side)]}
            onChange={(value) => onStyleField(borderWidthKey(side), value)}
          />
        ))}
      </div>
      <ToggleButton
        className={styles.linkToggle}
        pressed={linked}
        aria-label={t('manualEdit.spacing.linkAll')}
        title={linked ? t('manualEdit.shape.borderWidthsPerSide') : t('manualEdit.spacing.linkAll')}
        onPressedChange={(pressed) => {
          setLinked(pressed);
          if (pressed && !uniform) applyAll(values[0] ?? '');
        }}
      >
        <RemixIcon name={linked ? 'link' : 'link-unlink'} size={14} />
      </ToggleButton>
    </div>
  );
}

// Radius: the well's own corner rounds with the value, so the control previews
// what it edits.
function RadiusField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  const label = t('manualEdit.shape.radius');
  return (
    <div className={`${styles.field} ${styles.radiusField}`} style={{ '--radius-preview': previewRadius(value) } as CSSProperties}>
      <span className={`${styles.fieldIcon} ${styles.radiusGlyph}`} title={label} aria-hidden="true" />
      <Stepper label={label} value={stripPxUnit(value)} unit="px" step={1} onCommit={(raw) => onChange(emitPx(raw))} />
    </div>
  );
}

// Opacity: a slider whose track fades from clear to solid, plus the exact %.
function OpacityField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  const label = t('manualEdit.shape.opacity');
  const percent = opacityPercent(value);
  const sliderValue = isNumericInput(percent) ? Math.max(0, Math.min(100, Number(percent))) : 100;
  return (
    <div className={`${styles.field} ${styles.opacityField}`} style={{ '--opacity-preview': `${sliderValue}%` } as CSSProperties}>
      <span className={styles.fieldIcon} title={label}><RemixIcon name="contrast-drop-line" size={15} /></span>
      <input
        type="range"
        className={styles.opacityRange}
        aria-label={label}
        min={0}
        max={100}
        step={1}
        value={sliderValue}
        onChange={(event) => onChange(opacityValue(event.currentTarget.value))}
      />
      <Stepper label={label} value={percent} unit="%" step={1} onCommit={(raw) => onChange(opacityValue(raw))} compact />
    </div>
  );
}

function Stepper({
  label, value, unit, step, onCommit, compact,
}: {
  label: string;
  value: string;
  unit: string;
  step: number;
  onCommit: (raw: string) => void;
  compact?: boolean;
}) {
  const canStep = isNumericInput(value);
  const stepBy = (direction: -1 | 1) => {
    if (!canStep) return;
    onCommit(formatSteppedNumber(Number(value) + direction * step, value, step));
  };
  return (
    <span className={`${styles.stepper}${compact ? ` ${styles.stepperCompact}` : ''}`}>
      <button type="button" className={styles.step} disabled={!canStep} aria-label={`${label} decrease`} onClick={() => stepBy(-1)}>
        <RemixIcon name="subtract-line" size={13} />
      </button>
      <input
        aria-label={label}
        value={value}
        inputMode="decimal"
        onChange={(event) => onCommit(event.currentTarget.value)}
      />
      <em>{unit}</em>
      <button type="button" className={styles.step} disabled={!canStep} aria-label={`${label} increase`} onClick={() => stepBy(1)}>
        <RemixIcon name="add-line" size={13} />
      </button>
    </span>
  );
}

function NumericWell({
  className, label, value, onChange,
}: {
  className: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={className}>
      <input
        aria-label={label}
        title={label}
        inputMode="decimal"
        value={stripPxUnit(value)}
        onChange={(event) => onChange(emitPx(event.currentTarget.value))}
      />
      <em>px</em>
    </label>
  );
}

function emitPx(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed && isNumericInput(trimmed)) return `${trimmed}px`;
  if (/^-?\d+(\.\d+)?px$/i.test(trimmed)) return trimmed.toLowerCase();
  return raw;
}

function previewWidth(value: string): string {
  const numeric = Number.parseFloat(stripPxUnit(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return '0px';
  return `${Math.min(6, Math.max(1, Math.round(numeric)))}px`;
}

function previewRadius(value: string): string {
  const numeric = Number.parseFloat(stripPxUnit(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return '0px';
  return `${Math.min(10, Math.max(1, Math.round(numeric / 2)))}px`;
}

export function isNoFill(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === 'transparent';
}

export function opacityPercent(value: string): string {
  const numeric = parsePlainDecimal(value);
  if (numeric === undefined) return value;
  return String(Math.round(numeric * 10000) / 100);
}

export function opacityValue(value: string): string {
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
