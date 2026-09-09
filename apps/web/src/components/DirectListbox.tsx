// DirectListbox — the product's one-click dropdown.
//
// This is the composer's model/effort picker mechanism made reusable for any
// single-value field: a trigger that opens a body-portaled listbox placed by
// the shared `placePopover` maths, skinned by the same
// `.inline-switcher__popover--model` / `.inline-switcher__model-list` /
// `.inline-switcher__model-option` contract (192px minimum, `overflow-x: clip`,
// hover/focus reveal for labels that overflow). The question form's `select`
// field mounts it instead of a native `<select>`; InlineModelSwitcher keeps
// its own trigger (mode/agent/model chip) but consumes `ListboxOptionLabel`
// from here so the overflow-reveal label exists exactly once.
//
// Keyboard contract mirrors the native control it replaces (WAI-ARIA
// select-only combobox, real focus on options): ArrowDown/ArrowUp/Enter/Space
// open the list on the trigger, arrows/Home/End move through options, a
// printable key jumps to the next option starting with it, Enter/Space picks,
// Escape and Tab dismiss, and focus returns to the trigger.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { placePopover } from './popoverPlacement';

/**
 * One option label in a direct listbox.
 *
 * The panel is deliberately narrow, so a rare long label still cannot fit.
 * Rather than scroll the list horizontally the label truncates with an
 * ellipsis and, ONLY when it genuinely overflows, carries the measured overflow
 * distance. CSS then slides the text on hover and on keyboard focus so the tail
 * becomes readable; a label that fits is never flagged and never moves.
 */
export function ListboxOptionLabel({ label }: { label: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [reveal, setReveal] = useState(0);

  useLayoutEffect(() => {
    const viewport = ref.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    // Measure the intrinsic text, not the wrapper's scrollable overflow: that
    // changes while the text is translated and can erase the reveal on resize.
    const measure = () => {
      setReveal(Math.max(0, text.scrollWidth - viewport.clientWidth));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [label]);

  return (
    <span
      ref={ref}
      className="inline-switcher__model-option-label"
      data-overflowing={reveal > 0 ? 'true' : undefined}
      style={
        reveal > 0
          ? ({
              ['--inline-switcher-option-reveal' as string]: `${reveal}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <span ref={textRef} className="inline-switcher__model-option-label-text">{label}</span>
    </span>
  );
}

export interface DirectListboxOption {
  value: string;
  label: string;
  description?: string;
}

interface Props {
  options: DirectListboxOption[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name shared by the trigger and the listbox. */
  label: string;
  placeholder: string;
  disabled?: boolean;
  /** Extra class for the trigger so a host surface can style it as its own field. */
  className?: string;
  testId?: string;
}

const OPTION_SELECTOR = '[role="option"]';

export function DirectListbox({
  options,
  value,
  onChange,
  label,
  placeholder,
  disabled = false,
  className,
  testId,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Option to focus once the list has mounted: the selection, else the first.
  const pendingFocusRef = useRef<number | null>(null);
  const listId = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openList = useCallback(() => {
    if (disabled) return;
    pendingFocusRef.current = selectedIndex >= 0 ? selectedIndex : 0;
    setOpen(true);
  }, [disabled, selectedIndex]);

  const choose = useCallback(
    (index: number) => {
      const option = options[index];
      if (option && option.value !== value) onChange(option.value);
      close(true);
    },
    [close, onChange, options, value],
  );

  // Placement is measured, never assumed: the panel takes the trigger's width
  // (never narrower than the shared model-menu minimum from CSS), then the
  // measured box is clamped inside the viewport and re-placed on resize and on
  // any ancestor scroll, exactly like the composer picker.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    const place = () => {
      const anchor = triggerRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const anchorBox = anchor.getBoundingClientRect();
      if (anchorBox.width > 0) panel.style.minWidth = `${anchorBox.width}px`;
      const width = panel.offsetWidth;
      if (width === 0) return;
      setPos(
        placePopover(
          anchorBox,
          { width, height: panel.offsetHeight },
          {
            width: window.innerWidth || document.documentElement.clientWidth,
            height: window.innerHeight || document.documentElement.clientHeight,
          },
        ),
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Move focus into the list once it exists; roving focus is what drives the
  // shared option skin's `:focus` overflow reveal.
  useEffect(() => {
    if (!open) return;
    const index = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (index === null) return;
    panelRef.current
      ?.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR)
      .item(index)
      ?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [close, open]);

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (open) return;
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      event.preventDefault();
      openList();
    }
  }

  function handleListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        next = current === -1 ? 0 : (current + 1) % items.length;
        break;
      case 'ArrowUp':
        next = current === -1 ? items.length - 1 : (current - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (current !== -1) choose(current);
        return;
      case 'Escape':
        // The document listener also handles Escape; stop here so it does
        // not run twice on the same press.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case 'Tab':
        close(false);
        return;
      default: {
        // Type-ahead: the next option (after the active one, wrapping) whose
        // label starts with the pressed character, like the native control.
        if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;
        const char = event.key.toLowerCase();
        for (let step = 1; step <= options.length; step++) {
          const index = (current + step) % options.length;
          if (options[index]!.label.toLowerCase().startsWith(char)) {
            next = index;
            break;
          }
        }
        if (next === null) return;
      }
    }
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        // The trigger wears the product's shared select-trigger skin
        // (primitives.css) so it reads as a form field, not a composer chip.
        className={`readable-studio-select-trigger${className ? ` ${className}` : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        data-value={value}
        data-placeholder={selected ? undefined : 'true'}
        data-testid={testId}
        title={selected?.description ?? selected?.label}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="readable-studio-select-value">{selected?.label ?? placeholder}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              className="inline-switcher__popover inline-switcher__popover--layer inline-switcher__popover--model"
              style={
                pos === null
                  ? undefined
                  : ({
                      left: `${pos.left}px`,
                      top: `${pos.top}px`,
                      right: 'auto',
                      bottom: 'auto',
                    } satisfies CSSProperties)
              }
            >
              <div
                id={listId}
                className="inline-switcher__model-list"
                role="listbox"
                aria-label={label}
                onKeyDown={handleListKeyDown}
              >
                {options.map((option, index) => {
                  const isSelected = index === selectedIndex;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={`inline-switcher__model-option${isSelected ? ' is-active' : ''}`}
                      title={option.description ?? option.label}
                      onClick={() => choose(index)}
                    >
                      <ListboxOptionLabel label={option.label} />
                      <span className="inline-switcher__model-option-check" aria-hidden="true">
                        {isSelected ? <Icon name="check" size={13} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
