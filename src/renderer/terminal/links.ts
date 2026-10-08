import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

/**
 * Finds web links in the terminal, including links that a program broke over several lines
 * itself (Claude Code's sign-in URL, for example): a line that fills the full width and is followed
 * by a line starting with link characters is treated as continuing onto it. Soft-wrapped lines are
 * joined the same way.
 */
const URL_RE = /https?:\/\/[^\s"'<>`]+/g;
const MAX_LINES = 24;

interface Block {
  text: string;
  /** For each character of `text`: its buffer column and line (0-based). */
  pos: { x: number; y: number }[];
}

function lineAt(term: Terminal, y: number): IBufferLine | undefined {
  return term.buffer.active.getLine(y);
}

function textAt(term: Terminal, y: number): string {
  return lineAt(term, y)?.translateToString(true) ?? '';
}

/** Does line `y` carry on into line `y + 1`? */
function continues(term: Terminal, y: number): boolean {
  const next = lineAt(term, y + 1);
  if (!next) return false;
  if (next.isWrapped) return true;
  const here = textAt(term, y);
  const after = textAt(term, y + 1);
  return here.length >= term.cols && /[^\s]$/.test(here) && /^[A-Za-z0-9%&=?/._~:#@!$'()*+,;\[\]-]/.test(after);
}

function blockAround(term: Terminal, y: number): { start: number; block: Block } {
  let start = y;
  while (start > 0 && y - start < MAX_LINES && continues(term, start - 1)) start--;
  let end = y;
  while (end - start < MAX_LINES && continues(term, end)) end++;
  const block: Block = { text: '', pos: [] };
  for (let ly = start; ly <= end; ly++) {
    const t = textAt(term, ly);
    for (let x = 0; x < t.length; x++) block.pos.push({ x, y: ly });
    block.text += t;
  }
  return { start, block };
}

/** Links in a block, without trailing punctuation that is usually not part of the URL. */
function linksIn(block: Block): { url: string; from: number; to: number }[] {
  const out: { url: string; from: number; to: number }[] = [];
  for (const m of block.text.matchAll(URL_RE)) {
    let url = m[0];
    while (/[.,;:!?]$/.test(url) || (/\)$/.test(url) && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))) url = url.slice(0, -1);
    out.push({ url, from: m.index!, to: m.index! + url.length - 1 });
  }
  return out;
}

export function createLinkProvider(term: Terminal, open: (url: string) => void, canOpen: () => boolean): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const y = lineNumber - 1;
      const { block } = blockAround(term, y);
      const links: ILink[] = [];
      for (const l of linksIn(block)) {
        const a = block.pos[l.from];
        const b = block.pos[l.to];
        if (!a || !b || y < a.y || y > b.y) continue;
        links.push({
          range: { start: { x: a.x + 1, y: a.y + 1 }, end: { x: b.x + 1, y: b.y + 1 } },
          text: l.url,
          decorations: { pointerCursor: true, underline: true },
          activate: () => {
            if (canOpen()) open(l.url);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}

/** The last link printed in the terminal (searching the most recent `maxLines` lines). */
export function lastLink(term: Terminal, maxLines = 3000): string | null {
  const buf = term.buffer.active;
  const stop = Math.max(0, buf.length - maxLines);
  let y = buf.length - 1;
  while (y >= stop) {
    const { start, block } = blockAround(term, y);
    const found = linksIn(block);
    if (found.length) return found[found.length - 1].url;
    y = start - 1;
  }
  return null;
}
