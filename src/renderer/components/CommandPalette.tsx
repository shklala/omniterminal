import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../util';
import { Icon } from './Icon';

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  color?: string;
  group: 'Terminals' | 'Actions';
  run: () => void;
}

/** Subsequence fuzzy match; lower score is better. Returns null if no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    gaps += found - ti;
    ti = found + 1;
  }
  // Letters scattered across a long label are noise, not a match.
  if (gaps > q.length * 3) return null;
  return 100 + gaps;
}

/** Ctrl+Shift+P / Ctrl+K: jump to any terminal or run any action by typing. */
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    return items
      .map((it) => ({ it, score: fuzzyScore(query, `${it.label} ${it.hint ?? ''}`) }))
      .filter((r): r is { it: PaletteItem; score: number } => r.score !== null)
      .sort((a, b) => a.score - b.score || (a.it.group === b.it.group ? 0 : a.it.group === 'Terminals' ? -1 : 1))
      .map((r) => r.it);
  }, [items, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const runAt = (i: number) => {
    const it = results[i];
    if (!it) return;
    onClose();
    it.run();
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={15} />
          <input
            autoFocus
            placeholder="Jump to a terminal or run a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                runAt(index);
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((it, i) => (
            <button
              key={it.id}
              className={cx('palette-item', i === index && 'selected')}
              // mousemove, not mouseenter: a pointer resting where the list appears must not steal the
              // selection from the top match while the user is typing.
              onMouseMove={() => i !== index && setIndex(i)}
              onClick={() => runAt(i)}
            >
              {it.color ? <span className="profile-color" style={{ background: it.color }} /> : <Icon name={it.icon} size={14} />}
              <span className="palette-label">{it.label}</span>
              {it.hint && <span className="palette-hint">{it.hint}</span>}
              <span className="palette-group">{it.group === 'Terminals' ? 'Terminal' : 'Action'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
