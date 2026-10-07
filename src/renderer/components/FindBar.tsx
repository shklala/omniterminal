import { useEffect, useRef, useState } from 'react';
import type { TerminalHost } from '../terminal/terminalHost';
import { cx } from '../util';
import { Icon } from './Icon';

const DECORATIONS = {
  matchBackground: '#3b4a66',
  matchOverviewRuler: '#7aa2ff',
  activeMatchBackground: '#d29922',
  activeMatchColorOverviewRuler: '#d29922',
};

/** Ctrl+Shift+F search over the terminal buffer (scrollback included). */
export function FindBar({ host, onClose }: { host: TerminalHost; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const sub = host.search.onDidChangeResults((r) => setResult(r.resultCount ? { index: r.resultIndex, count: r.resultCount } : { index: -1, count: 0 }));
    return () => {
      sub.dispose();
      host.search.clearDecorations();
    };
  }, [host]);

  const opts = { caseSensitive, regex, decorations: DECORATIONS, incremental: false };
  const find = (dir: 'next' | 'prev', q = query) => {
    if (!q) {
      host.search.clearDecorations();
      setResult(null);
      return;
    }
    try {
      if (dir === 'next') host.search.findNext(q, opts);
      else host.search.findPrevious(q, opts);
    } catch {
      setResult({ index: -1, count: 0 }); // invalid regex
    }
  };

  useEffect(() => {
    if (!query) {
      host.search.clearDecorations();
      setResult(null);
      return;
    }
    try {
      host.search.findNext(query, { ...opts, incremental: true });
    } catch {
      setResult({ index: -1, count: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, regex]);

  const close = () => {
    onClose();
    host.focus();
  };

  return (
    <div className="find-bar" onKeyDown={(e) => e.stopPropagation()}>
      <Icon name="search" size={14} />
      <input
        ref={input}
        value={query}
        placeholder="Find in terminal"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(e.shiftKey ? 'prev' : 'next');
          if (e.key === 'Escape') close();
        }}
      />
      <span className="find-count">{result ? (result.count ? `${result.index + 1}/${result.count}` : 'No results') : ''}</span>
      <button className={cx('find-toggle', caseSensitive && 'on')} title="Match case" onClick={() => setCaseSensitive((v) => !v)}>Aa</button>
      <button className={cx('find-toggle', regex && 'on')} title="Regular expression" onClick={() => setRegex((v) => !v)}>.*</button>
      <button className="icon-btn small" title="Previous (Shift+Enter)" onClick={() => find('prev')}>↑</button>
      <button className="icon-btn small" title="Next (Enter)" onClick={() => find('next')}>↓</button>
      <button className="icon-btn small" title="Close (Esc)" onClick={close}><Icon name="x" size={13} /></button>
    </div>
  );
}
