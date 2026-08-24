import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSessionMode } from '@readable-studio/contracts';
import { useT } from '../i18n';
import { Icon } from './Icon';

// Gap between the trigger and the popover, and the minimum breathing room kept
// against every viewport edge when the computed rect is clamped.
const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 16;
// Conservative popover box used only for clamping. Over-estimating just nudges
// the popover further inside the viewport, which is always safe.
const POPOVER_WIDTH = 500;
const POPOVER_HEIGHT = 380;
// The popover is a body-level fixed layer, so the pointer physically leaves the
// toggle's box while travelling toward it. Defer the preview reset long enough
// to cross that gap; entering the popover cancels the pending reset. Mirrors
// FLYOUT_CLOSE_DELAY_MS in NextStepActions.tsx.
const PREVIEW_CLOSE_DELAY_MS = 240;

type PopoverRect = { left: number; top: number; flipped: boolean };

// Place the popover above its trigger, flipping to right-anchored when the
// natural left-anchored box would overflow, then clamp both axes so the layer
// can never be positioned off-screen.
function placeAbove(anchor: DOMRect): PopoverRect {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2);
  const flipped = anchor.left + width > viewportWidth - VIEWPORT_MARGIN;
  const rawLeft = flipped ? anchor.right - width : anchor.left;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
  const rawTop = anchor.top - POPOVER_GAP - POPOVER_HEIGHT;
  const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - POPOVER_HEIGHT);
  return {
    left: Math.min(Math.max(VIEWPORT_MARGIN, rawLeft), maxLeft),
    top: Math.min(Math.max(VIEWPORT_MARGIN, rawTop), maxTop),
    flipped,
  };
}

// The popover used to be a DOM descendant of its anchor, so context rules like
// `.composer .session-mode-toggle__popover-card` and the home-hero card cap
// matched by ancestry. Portaled to <body> that ancestry is gone, so the host
// surface is resolved once at open time and mirrored onto the portaled node.
function resolveSurface(node: HTMLElement | null): 'composer' | 'home-hero' | null {
  if (node?.closest('.home-hero__input-card')) return 'home-hero';
  if (node?.closest('.composer')) return 'composer';
  return null;
}

interface Props {
  mode: ChatSessionMode;
  onChange?: (mode: ChatSessionMode) => void;
  disabled?: boolean;
}

const MODE_META: Array<{
  mode: ChatSessionMode;
  icon: 'comment' | 'sparkles';
  labelKey: ModeCopyKey;
  titleKey: ModeCopyKey;
  summaryKey: ModeCopyKey;
  solvesKey: ModeCopyKey;
  queryKeys: [ModeCopyKey, ModeCopyKey, ModeCopyKey];
}> = [
  {
    mode: 'chat',
    icon: 'comment',
    labelKey: 'chat.mode.chat.label',
    titleKey: 'chat.mode.chat.title',
    summaryKey: 'chat.mode.chat.summary',
    solvesKey: 'chat.mode.chat.solves',
    queryKeys: ['chat.mode.chat.query1', 'chat.mode.chat.query2', 'chat.mode.chat.query3'],
  },
  {
    mode: 'design',
    icon: 'sparkles',
    labelKey: 'chat.mode.design.label',
    titleKey: 'chat.mode.design.title',
    summaryKey: 'chat.mode.design.summary',
    solvesKey: 'chat.mode.design.solves',
    queryKeys: ['chat.mode.design.query1', 'chat.mode.design.query2', 'chat.mode.design.query3'],
  },
];

type ModeCopyKey =
  | 'chat.mode.chat.label'
  | 'chat.mode.chat.title'
  | 'chat.mode.chat.summary'
  | 'chat.mode.chat.solves'
  | 'chat.mode.chat.query1'
  | 'chat.mode.chat.query2'
  | 'chat.mode.chat.query3'
  | 'chat.mode.design.label'
  | 'chat.mode.design.title'
  | 'chat.mode.design.summary'
  | 'chat.mode.design.solves'
  | 'chat.mode.design.query1'
  | 'chat.mode.design.query2'
  | 'chat.mode.design.query3';

interface ModeView {
  mode: ChatSessionMode;
  icon: 'comment' | 'sparkles';
  label: string;
  title: string;
  summary: string;
  solves: string;
  queries: string[];
}

function ModeDescriptionCard({
  item,
  bestForLabel,
  tryLabel,
  className,
  id,
  role,
}: {
  item: ModeView;
  bestForLabel: string;
  tryLabel: string;
  className: string;
  id?: string;
  role?: 'tooltip';
}) {
  return (
    <div className={`session-mode-card ${className}`} id={id} role={role}>
      <div className="session-mode-card__head">
        <span className="session-mode-card__icon" aria-hidden>
          <Icon name={item.icon} size={14} />
        </span>
        <div className="session-mode-card__heading">
          <div className="session-mode-card__title">{item.title}</div>
          <div className="session-mode-card__label">{item.label}</div>
        </div>
      </div>
      <p className="session-mode-card__summary">{item.summary}</p>
      <div className="session-mode-card__section">
        <div className="session-mode-card__section-label">{bestForLabel}</div>
        <p className="session-mode-card__section-text">{item.solves}</p>
      </div>
      <div className="session-mode-card__section">
        <div className="session-mode-card__section-label">{tryLabel}</div>
        <ul className="session-mode-card__queries">
          {item.queries.map((query) => (
            <li key={query} className="session-mode-card__query">
              {query}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function SessionModeToggle({ mode, onChange, disabled = false }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<ChatSessionMode | null>(null);
  const [rect, setRect] = useState<PopoverRect | null>(null);
  const [surface, setSurface] = useState<'composer' | 'home-hero' | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const previewCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardId = useId();
  const modes = MODE_META.map<ModeView>((item) => ({
    mode: item.mode,
    icon: item.icon,
    label: t(item.labelKey),
    title: t(item.titleKey),
    summary: t(item.summaryKey),
    solves: t(item.solvesKey),
    queries: item.queryKeys.map((queryKey) => t(queryKey)),
  }));
  const active = modes.find((item) => item.mode === mode) ?? modes[1]!;
  const preview = modes.find((item) => item.mode === (previewMode ?? mode)) ?? active;
  const disabledState = disabled || !onChange;
  const showCard = open && !disabledState;

  const cancelPreviewClose = useCallback(() => {
    if (previewCloseTimer.current) {
      clearTimeout(previewCloseTimer.current);
      previewCloseTimer.current = null;
    }
  }, []);

  // Hover intent: the trigger and the portaled popover are separated by a real
  // gap, so resetting the preview the instant the pointer leaves either one
  // makes the traverse feel broken.
  const schedulePreviewClose = useCallback(() => {
    cancelPreviewClose();
    previewCloseTimer.current = setTimeout(() => {
      setPreviewMode(null);
      previewCloseTimer.current = null;
    }, PREVIEW_CLOSE_DELAY_MS);
  }, [cancelPreviewClose]);

  useEffect(() => () => cancelPreviewClose(), [cancelPreviewClose]);

  const closeMenu = useCallback(() => {
    cancelPreviewClose();
    setOpen(false);
    setPreviewMode(null);
  }, [cancelPreviewClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const anchor = (triggerRef.current ?? rootRef.current)?.getBoundingClientRect();
      if (anchor) setRect(placeAbove(anchor));
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu, open]);

  return (
    <div
      className="session-mode-toggle"
      ref={rootRef}
      onPointerEnter={cancelPreviewClose}
      onPointerLeave={() => {
        if (!open) schedulePreviewClose();
      }}
      onBlur={(event) => {
        if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return;
        if (!open) schedulePreviewClose();
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`session-mode-toggle__trigger readable-tooltip${open ? ' is-open' : ''}`}
        disabled={disabledState}
        aria-label={active.title}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active.title}
        data-tooltip={active.title}
        data-testid="session-mode-trigger"
        onClick={(event) => {
          if (open) {
            closeMenu();
            return;
          }
          const trigger = event.currentTarget;
          setSurface(resolveSurface(trigger));
          setRect(placeAbove(trigger.getBoundingClientRect()));
          setOpen(true);
          setPreviewMode(mode);
        }}
      >
        <Icon name={active.icon} size={13} />
        <span className="session-mode-toggle__label">{active.label}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && rect && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popoverRef}
          className={`session-mode-toggle__popover${rect.flipped ? ' is-flipped' : ''}${
            surface ? ` session-mode-toggle__popover--${surface}` : ''
          }`}
          style={{ left: `${rect.left}px`, top: `${rect.top}px` }}
          onPointerEnter={cancelPreviewClose}
          onPointerLeave={() => {
            if (!open) schedulePreviewClose();
          }}
        >
          <div className="session-mode-toggle__menu" role="menu">
            <div className="session-mode-toggle__options">
              {modes.map((item) => {
                const itemActive = item.mode === mode;
                return (
                  <button
                    key={item.mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={itemActive}
                    className={`session-mode-toggle__option${itemActive ? ' is-active' : ''}`}
                    aria-label={item.title}
                    onPointerEnter={() => {
                      cancelPreviewClose();
                      setPreviewMode(item.mode);
                    }}
                    onFocus={() => {
                      cancelPreviewClose();
                      setPreviewMode(item.mode);
                    }}
                    onClick={() => {
                      if (!itemActive) onChange?.(item.mode);
                      closeMenu();
                    }}
                  >
                    <Icon name={item.icon} size={13} />
                    <span className="session-mode-toggle__label">{item.label}</span>
                    <span className="session-mode-toggle__check" aria-hidden>
                      {itemActive ? <Icon name="check" size={13} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {showCard ? (
            <ModeDescriptionCard
              item={preview}
              bestForLabel={t('chat.mode.cardBestFor')}
              tryLabel={t('chat.mode.cardTry')}
              className="session-mode-toggle__popover-card"
              id={cardId}
              role="tooltip"
            />
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
