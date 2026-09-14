// Theme modal for the hub rail footer.
//
// The footer's Theme row opens this directly: no settings screen, no submenu,
// no navigation. The rail is an `overflow: hidden` glass box (44px wide when
// collapsed), so like every other rail-owned overlay this one leaves the rail
// entirely: it is portalled to the body on the shared modal material
// (`modal-backdrop` / `modal`) and stacked above the content column.
//
// The theme itself is NOT owned here. Selecting a card calls `onThemeChange`,
// which is App's existing appearance path (`saveConfig` + daemon sync +
// `applyAppearanceToDocument` through the config layout effect); `theme` is
// the value that path currently holds. The modal never writes the config or
// the document on its own, so there is one source of truth for the active
// theme.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { AnimatePresence, motion, type Variants } from 'motion/react';
import { createPortal } from 'react-dom';
import { Button, ToggleCard } from '@readable-studio/components';

import { useEscapeDismiss } from '../../hooks/useEscapeDismiss';
import { useT } from '../../i18n';
import { useFadingSurface } from '../../motion';
import { DEFAULT_THEME, THEME_OPTIONS } from '../../state/themes';
import type { AppTheme } from '../../types';
import { Icon } from '../Icon';
import { rootTokenValues } from '../theme-tokens';
import styles from './HubThemeModal.module.css';

export const HUB_THEME_DIALOG_ID = 'hub-theme-dialog';

// The repository's ease-out curve (`--ease-out`) with the token asymmetry
// (`--dur-enter` 200ms reads gentle, `--dur-exit` 140ms reads decisive).
// Reduced motion is the root `MotionConfig reducedMotion="user"`: it zeroes
// the transform half of these variants and keeps the fade.
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const ENTER_SECONDS = 0.2;
const EXIT_SECONDS = 0.14;

const backdropVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: ENTER_SECONDS, ease: EASE_OUT } },
  exit: {
    opacity: 0,
    pointerEvents: 'none',
    transition: { duration: EXIT_SECONDS, ease: EASE_OUT },
  },
};

// Never from scale(0): the surface settles in from 0.96 with the fade.
const dialogVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: ENTER_SECONDS, ease: EASE_OUT },
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    y: 4,
    transition: { duration: EXIT_SECONDS, ease: EASE_OUT },
  },
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]):not([tabindex="-1"]), [href], [tabindex]:not([tabindex="-1"])';

interface Props {
  open: boolean;
  /** The theme the app config currently holds. */
  theme: AppTheme | undefined;
  /** App's appearance path: persists the choice and applies it live. */
  onThemeChange: (theme: AppTheme) => void;
  onClose: () => void;
  /** The rail row that opened the modal; focus lands back on it on close. */
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function HubThemeModal({ open, ...rest }: Props) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>{open ? <HubThemeModalBody {...rest} /> : null}</AnimatePresence>,
    document.body,
  );
}

function themeIndexForKey(currentIndex: number, key: string): number | null {
  if (key === 'ArrowDown' || key === 'ArrowRight') return (currentIndex + 1) % THEME_OPTIONS.length;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (currentIndex - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
  if (key === 'Home') return 0;
  if (key === 'End') return THEME_OPTIONS.length - 1;
  return null;
}

type ExplicitTheme = Exclude<AppTheme, 'system'>;

/**
 * The semantic tokens a card miniature paints (the module resolves nothing
 * else): the theme's canvas, its panel surface and hairline, its accent and
 * two rungs of its ink scale.
 */
const PREVIEW_TOKENS = ['--bg', '--bg-panel', '--border', '--accent', '--text', '--text-muted'] as const;

/**
 * One theme's canvas, panel, accent and ink, painted from that theme's own
 * tokens: `data-theme` scopes the stylesheets' theme block to this subtree,
 * and light additionally carries the `:root` baseline it is defined by (read
 * off the loaded sheets by `rootTokenValues`, shared with the settings
 * surfaces' theme chips, so the light card stays true inside a dark or
 * named-theme document without this file carrying a palette of its own).
 */
function ThemeMiniature({
  theme,
  lightBaseline,
  split = false,
}: {
  theme: ExplicitTheme;
  lightBaseline: CSSProperties;
  split?: boolean;
}) {
  return (
    <span
      className={split ? `${styles.canvas} ${styles.canvasSplit}` : styles.canvas}
      data-theme={theme}
      style={theme === 'light' ? lightBaseline : undefined}
    >
      <span className={styles.surface}>
        <span className={styles.accent} />
        <span className={styles.ink} />
        <span className={styles.inkMuted} />
      </span>
    </span>
  );
}

function HubThemeModalBody({
  theme,
  onThemeChange,
  onClose,
  returnFocusRef,
}: Omit<Props, 'open'>) {
  const t = useT();
  const dialogRef = useRef<HTMLElement | null>(null);
  const backdropMotion = useFadingSurface(backdropVariants);
  const dialogMotion = useFadingSurface(dialogVariants);
  const current = theme ?? DEFAULT_THEME;
  // Once per open: the light miniatures' baseline, straight from the sheets.
  const lightBaseline = useMemo(() => rootTokenValues(PREVIEW_TOKENS), []);

  const focusCard = useCallback((id: AppTheme) => {
    dialogRef.current
      ?.querySelector<HTMLButtonElement>(`[data-theme-option="${id}"]`)
      ?.focus();
  }, []);

  // The bundle's `ref` is the exit gate's handle on the animated root (it is
  // what lets `onAnimationStart` set `inert` on the fading subtree), and the
  // focus logic here needs the same node, so one callback feeds both. It is
  // passed after the `dialogMotion` spread on purpose: a later `ref` replaces
  // the bundle's, and this one forwards to it.
  const setDialogRef = useCallback(
    (node: HTMLElement | null) => {
      dialogRef.current = node;
      dialogMotion.ref(node);
    },
    [dialogMotion.ref],
  );

  useEscapeDismiss(onClose);

  // Keyboard scope stays inside the dialog for as long as it is mounted, and
  // the rail row that opened it gets focus back the moment it leaves - the
  // rail's roving tabindex is meaningless if a dismissed modal drops focus to
  // the body. Runs once per mount on purpose: the current theme changes while
  // the modal is open, and that must not yank focus around.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current
      ?.querySelector<HTMLButtonElement>(`[data-theme-option="${current}"]`)
      ?.focus();
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      dialog.querySelector<HTMLButtonElement>('[role="radio"][tabindex="0"]')?.focus();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.body.style.overflow = previousOverflow;
      const back = returnFocusRef.current;
      if (back?.isConnected) back.focus();
    };
  }, []);

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!event.currentTarget.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <motion.div
      className={`modal-backdrop ${styles.backdrop}`}
      role="presentation"
      data-testid="hub-theme-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      {...backdropMotion}
    >
      <motion.section
        id={HUB_THEME_DIALOG_ID}
        className={`modal ${styles.modal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hub-theme-title"
        aria-describedby="hub-theme-subtitle"
        data-testid="hub-theme-modal"
        onKeyDown={onDialogKeyDown}
        {...dialogMotion}
        ref={setDialogRef}
      >
        <header className={styles.head}>
          <span className={styles.glyph} aria-hidden="true">
            <Icon name="sun-moon" size={18} strokeWidth={1.6} />
          </span>
          <div className={styles.titles}>
            <h2 id="hub-theme-title">{t('hub.theme')}</h2>
            <p id="hub-theme-subtitle">{t('hub.themeSubtitle')}</p>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            data-testid="hub-theme-close"
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className={styles.body}>
          <div
            className={styles.grid}
            role="radiogroup"
            aria-label={t('settings.appearance')}
            data-testid="hub-theme-options"
          >
            {THEME_OPTIONS.map((option, index) => {
              const active = option.id === current;
              // Light and Dark name their own scheme; every other theme says
              // which side it lands on so the grid can be scanned by scheme.
              const scheme =
                option.scheme === 'system' || option.id === option.scheme
                  ? null
                  : t(option.scheme === 'dark' ? 'settings.themeDark' : 'settings.themeLight');
              return (
                <ToggleCard
                  key={option.id}
                  className={styles.card}
                  pressed={active}
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  data-theme-option={option.id}
                  data-testid={`hub-theme-option-${option.id}`}
                  onPressedChange={() => {
                    if (!active) onThemeChange(option.id);
                  }}
                  onKeyDown={(event) => {
                    const nextIndex = themeIndexForKey(index, event.key);
                    if (nextIndex == null) return;
                    event.preventDefault();
                    const next = THEME_OPTIONS[nextIndex];
                    if (!next) return;
                    if (next.id !== current) onThemeChange(next.id);
                    focusCard(next.id);
                  }}
                >
                  <span className={styles.preview} aria-hidden="true">
                    {option.id === 'system' ? (
                      // Both palettes the setting can resolve to, each the
                      // real one: light underneath, dark past a diagonal seam.
                      <>
                        <ThemeMiniature theme="light" lightBaseline={lightBaseline} />
                        <ThemeMiniature theme="dark" lightBaseline={lightBaseline} split />
                      </>
                    ) : (
                      <ThemeMiniature theme={option.id} lightBaseline={lightBaseline} />
                    )}
                  </span>
                  <span className={styles.meta}>
                    <span className={styles.label}>{t(option.labelKey)}</span>
                    {scheme ? <span className={styles.scheme}>{scheme}</span> : null}
                  </span>
                  {active ? (
                    <span className={styles.check} aria-hidden="true">
                      <Icon name="check" size={12} strokeWidth={2.2} />
                    </span>
                  ) : null}
                </ToggleCard>
              );
            })}
          </div>
        </div>

        <footer className={styles.foot}>
          <Button variant="primary" onClick={onClose} data-testid="hub-theme-done">
            {t('hub.themeDone')}
          </Button>
        </footer>
      </motion.section>
    </motion.div>
  );
}
