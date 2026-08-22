// Shared vertical inspector row primitives for manual-edit mode. These render
// the Claude-style `.cc-*` inspector rows used by the left-panel edit inspector
// (Text / Shape / Page sections) so every section shares one visual language.
// The horizontal docked toolbars keep their own compact primitives; these are
// the stacked equivalents.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@readable-studio/components';
import { useT } from '../i18n';
import { RemixIcon } from './RemixIcon';
import { useSystemFonts } from './useSystemFonts';
import { systemFontOptions } from './font-options';
import {
  EDITOR_SWATCH_COLORS,
  FONT_OPTS,
  fontFamilyLabel,
  normalizeColorForPicker,
  normalizeFontFamilyForSelect,
  stripPxUnit,
} from './ManualEditPanel';

export function Section({
  title,
  description,
  children,
  inactive,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  inactive?: boolean;
}) {
  return (
    <section className={`cc-section${inactive ? ' cc-section-inactive' : ''}`}>
      <header className="cc-section-head">{title}</header>
      {description ? <p className="cc-section-description">{description}</p> : null}
      <div className="cc-section-body">{children}</div>
    </section>
  );
}

export function DisclosureSection({
  title,
  summary,
  icon,
  children,
  defaultOpen = false,
}: {
  title: string;
  summary?: string;
  icon: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <section className="cc-disclosure">
      <Button
        variant="subtle"
        className="cc-disclosure-head"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <RemixIcon name={icon} size={16} />
        <strong>{title}</strong>
        {summary ? <span className="cc-disclosure-summary">{summary}</span> : null}
        <RemixIcon name="arrow-down-s-line" size={16} />
      </Button>
      <div
        id={contentId}
        className={`accordion-collapsible${open ? ' open' : ''}`}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="accordion-collapsible-inner">
          <div className="cc-disclosure-body">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function Subsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="cc-subsection">
      <h3 className="cc-subsection-title">{title}</h3>
      <div className="cc-subsection-body">{children}</div>
    </section>
  );
}

function FieldLabel({ label, description }: { label: string; description?: string }) {
  return (
    <span className="cc-field-copy">
      <span className="cc-label">{label}</span>
      {description ? <small className="cc-description">{description}</small> : null}
    </span>
  );
}

// Numeric field with stepper buttons. `unit: 'px'` strips/re-adds px on display;
// `autoUnit` appends px to a bare number on commit (width/height/gap/etc.).
export function NumberRow({
  label,
  description,
  value,
  onChange,
  unit,
  autoUnit,
  disabled,
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  unit: string;
  autoUnit?: boolean;
  disabled?: boolean;
}) {
  const display = unit === 'px' ? stripPxUnit(value) : value;
  const step = unit === 'px' || unit === '%' ? 1 : 0.1;
  const canStep = !disabled && isNumericInput(display);
  const valueFromDisplay = (raw: string) => {
    const trimmed = raw.trim();
    if (autoUnit && trimmed && isNumericInput(trimmed)) return `${trimmed}px`;
    if (autoUnit && /^-?\d+(\.\d+)?px$/i.test(trimmed)) return trimmed.toLowerCase();
    return raw;
  };
  const handle = (raw: string) => {
    const next = valueFromDisplay(raw);
    if (next !== value) onChange(next);
  };
  const stepBy = (direction: -1 | 1) => {
    if (!canStep) return;
    const next = formatSteppedNumber(Number(display) + direction * step, display, step);
    onChange(valueFromDisplay(next));
  };
  return (
    <label className="cc-row">
      <FieldLabel label={label} description={description} />
      <span className="cc-value">
        <button
          type="button"
          className="cc-step"
          disabled={!canStep}
          aria-label={`${label} decrease`}
          onClick={() => stepBy(-1)}
        >
          −
        </button>
        <input
          aria-label={label}
          value={display}
          placeholder=""
          disabled={disabled}
          inputMode="decimal"
          onChange={(e) => onChange(valueFromDisplay(e.currentTarget.value))}
          onBlur={(e) => handle(e.currentTarget.value)}
        />
        <button
          type="button"
          className="cc-step"
          disabled={!canStep}
          aria-label={`${label} increase`}
          onClick={() => stepBy(1)}
        >
          +
        </button>
        {unit ? <em className="cc-unit">{unit}</em> : null}
      </span>
    </label>
  );
}

// Native select styled as a cc-row. Keeps the current off-list value selectable
// so a pre-existing style is never silently dropped.
export function SelectRow({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: string;
  options: ReadonlyArray<string>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="cc-row">
      <FieldLabel label={label} description={description} />
      <span className="cc-value cc-select">
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {!options.includes(value) && value ? <option value={value}>{value}</option> : null}
          {options.map((option) => (
            <option key={option || '__'} value={option}>{option || '–'}</option>
          ))}
        </select>
        <em className="cc-chevron">▾</em>
      </span>
    </label>
  );
}

// Segmented icon toggles inside a cc-row (bold/italic/underline, text-align).
// Clicking the active value again clears it when `allowClear` is set.
export function ToggleRow({
  label,
  description,
  options,
  value,
  pressed,
  disabled,
  allowClear,
  onSelect,
}: {
  label: string;
  description?: string;
  options: ReadonlyArray<{ value: string; icon: string; label: string }>;
  value?: string;
  pressed?: (value: string) => boolean;
  disabled?: boolean;
  allowClear?: boolean;
  onSelect: (value: string, wasPressed: boolean) => void;
}) {
  const isPressed = (optionValue: string) =>
    pressed ? pressed(optionValue) : value === optionValue;
  return (
    <div className="cc-row cc-row-toggle" role="group" aria-label={label}>
      <FieldLabel label={label} description={description} />
      <span className="cc-value cc-toggle-group">
        {options.map((option) => {
          const on = isPressed(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className={`cc-toggle${on ? ' cc-toggle-on' : ''}`}
              aria-label={option.label}
              aria-pressed={on}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(option.value, allowClear ? on : false)}
            >
              <RemixIcon name={option.icon} size={14} />
            </button>
          );
        })}
      </span>
    </div>
  );
}

// Color swatch + text input + popover, matching the page inspector's ColorRow.
export function ColorRow({
  label,
  description,
  value,
  onChange,
  compact,
  disabled = false,
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (v: string) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <label className="cc-row">
      {compact ? null : <FieldLabel label={label} description={description} />}
      <span className={`cc-value cc-color ${compact ? 'cc-color-compact' : ''}`} ref={ref}>
        <button
          type="button"
          className="cc-swatch"
          style={{ background: value || 'transparent' }}
          onClick={() => setOpen((v) => !v)}
          aria-label={`Pick ${label}`}
          disabled={disabled}
        />
        <input
          value={value}
          placeholder="#000000"
          aria-label={label}
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.value)}
          onFocus={() => { if (!disabled) setOpen(true); }}
        />
        {open && !disabled ? (
          <div className="cc-color-popover">
            <div className="cc-color-grid">
              {EDITOR_SWATCH_COLORS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className="cc-color-tile"
                  style={{ background: hex }}
                  onClick={() => {
                    onChange(hex);
                    setOpen(false);
                  }}
                  aria-label={hex}
                />
              ))}
            </div>
            <input
              type="color"
              className="cc-color-native"
              value={normalizeColorForPicker(value)}
              disabled={disabled}
              onChange={(e) => onChange(e.currentTarget.value)}
            />
          </div>
        ) : null}
      </span>
    </label>
  );
}

// Font family select with a curated list plus installed system fonts.
export function FontSelectRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useT();
  const { families } = useSystemFonts();
  const systemOptions = systemFontOptions(families, FONT_OPTS);
  const normalizedValue = normalizeFontFamilyForSelect(value);
  const customValue = normalizedValue === value ? value : '';
  const isCurated = FONT_OPTS.some((option) => option.value === customValue);
  const isSystem = systemOptions.some((option) => option.value === customValue);
  return (
    <label className="cc-row">
      <FieldLabel label={label} description={description} />
      <span className="cc-value cc-select">
        <select
          aria-label={label}
          value={normalizedValue}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {customValue && !isCurated && !isSystem ? (
            <option value={customValue}>{fontFamilyLabel(customValue)}</option>
          ) : null}
          {FONT_OPTS.map((option) => (
            <option key={option.label} value={option.value}>{option.label}</option>
          ))}
          {systemOptions.length ? (
            <optgroup label={t('manualEdit.systemFontsGroup')}>
              {systemOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <em className="cc-chevron">▾</em>
      </span>
    </label>
  );
}

// A labelled 2x2 group of small numeric fields (padding, margin, border widths).
export function QuadField({
  label,
  description,
  sideLabels,
  values,
  onChange,
}: {
  label: string;
  description?: string;
  sideLabels: { t: string; r: string; b: string; l: string };
  values: { t: string; r: string; b: string; l: string };
  onChange: (side: 't' | 'r' | 'b' | 'l', value: string) => void;
}) {
  return (
    <div className="cc-quad">
      <div className="cc-quad-head">
        <span className="cc-quad-label">{label}</span>
        {description ? <small className="cc-description">{description}</small> : null}
      </div>
      <div className="cc-quad-grid">
        <QuadInput label={sideLabels.t} value={values.t} onChange={(v) => onChange('t', v)} />
        <QuadInput label={sideLabels.r} value={values.r} onChange={(v) => onChange('r', v)} />
        <QuadInput label={sideLabels.b} value={values.b} onChange={(v) => onChange('b', v)} />
        <QuadInput label={sideLabels.l} value={values.l} onChange={(v) => onChange('l', v)} />
      </div>
    </div>
  );
}

function QuadInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const display = stripPxUnit(value);
  const emit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed && isNumericInput(trimmed)) return `${trimmed}px`;
    if (/^-?\d+(\.\d+)?px$/i.test(trimmed)) return trimmed.toLowerCase();
    return raw;
  };
  return (
    <label className="cc-row cc-quad-cell">
      <span className="cc-quad-side">{label}</span>
      <span className="cc-value">
        <input
          aria-label={label}
          value={display}
          inputMode="decimal"
          onChange={(event) => onChange(emit(event.currentTarget.value))}
        />
      </span>
    </label>
  );
}

// Icon button rendered as a cc-row action (image replace, delete, etc.).
export function ActionRow({
  icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`cc-action${danger ? ' cc-action-danger' : ''}`}
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
    >
      <RemixIcon name={icon} size={14} />
      <span>{label}</span>
    </button>
  );
}

export function isNumericInput(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

export function formatSteppedNumber(value: number, current: string, step: number): string {
  const decimals = Math.max(decimalPlaces(current), decimalPlaces(String(step)));
  return decimals > 0
    ? value.toFixed(decimals).replace(/\.?0+$/, '')
    : String(Math.round(value));
}

function decimalPlaces(value: string): number {
  const match = value.match(/\.(\d+)/);
  return match?.[1]?.length ?? 0;
}
