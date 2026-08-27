import { useEffect, useMemo, useRef, useState } from 'react';

export interface HubPaletteEntry {
  id: string;
  group: string;
  title: string;
  meta?: string;
  kind: 'project' | 'session' | 'destination';
  activate: () => void;
}

interface Props {
  entries: HubPaletteEntry[];
  onClose: () => void;
}

export function HubCommandPalette({ entries, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const hits = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      `${entry.title} ${entry.meta ?? ''} ${entry.group}`.toLocaleLowerCase().includes(needle),
    );
  }, [entries, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, hits.length - 1)));
  }, [hits.length]);

  const activate = (index: number) => {
    const entry = hits[index];
    if (!entry) return;
    onClose();
    entry.activate();
  };

  return (
    <div className="hub-palette__scrim" data-testid="hub-palette-scrim" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className="hub-palette"
        data-testid="hub-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search projects, sessions, and destinations"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setCursor((current) => Math.min(current + 1, hits.length - 1));
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setCursor((current) => Math.max(current - 1, 0));
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            activate(cursor);
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [],
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="hub-palette__input-row">
          <span className="hub-palette__search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="hub-palette__input"
            data-testid="hub-palette-input"
            value={query}
            placeholder="Search projects, sessions, and destinations"
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="hub-palette-list"
            aria-activedescendant={hits[cursor] ? `hub-palette-${hits[cursor].id}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
          />
          <kbd className="hub-kbd">Esc</kbd>
        </div>
        <div id="hub-palette-list" className="hub-palette__list" role="listbox">
          {hits.length === 0 ? <p className="hub-palette__empty">No matching results</p> : null}
          {hits.map((entry, index) => {
            const previous = hits[index - 1];
            return (
              <div key={entry.id}>
                {!previous || previous.group !== entry.group ? (
                  <div className="hub-palette__group">{entry.group}</div>
                ) : null}
                <button
                  id={`hub-palette-${entry.id}`}
                  type="button"
                  role="option"
                  aria-selected={cursor === index}
                  tabIndex={-1}
                  className="hub-palette__item"
                  data-kind={entry.kind}
                  data-testid={`hub-palette-item-${entry.id}`}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => activate(index)}
                >
                  <span className={`hub-palette__item-icon hub-palette__item-icon--${entry.kind}`} aria-hidden="true" />
                  <span className="hub-palette__item-title">{entry.title}</span>
                  {entry.meta ? <span className="hub-palette__item-meta">{entry.meta}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
        <div className="hub-palette__foot">
          <span><kbd className="hub-kbd">↑↓</kbd> Move</span>
          <span><kbd className="hub-kbd">Enter</kbd> Open</span>
          <span><kbd className="hub-kbd">Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
