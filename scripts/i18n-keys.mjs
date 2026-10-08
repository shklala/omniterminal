// Lists every UI string passed to t()/tr() (plus tool texts) and, per language, which are missing.
// Usage: node scripts/i18n-keys.mjs [--json]
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'locales') walk(p);
    } else if (/\.(tsx?|ts)$/.test(e.name)) files.push(p);
  }
})(path.join(root, 'src', 'renderer'));

/** Reads a JS string literal starting at s[i] (quote char); returns [value, endIndex] or null. */
function readLiteral(s, i) {
  const q = s[i];
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') {
      const n = s[j + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      j++;
    } else if (ch === q) return [out, j];
    else if (q === '`' && ch === '$' && s[j + 1] === '{') return null; // template with expressions
    else out += ch;
  }
  return null;
}

const keys = new Set();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /\b(?:t|tr)\(\s*(['"`])/g;
  let m;
  while ((m = re.exec(s))) {
    const lit = readLiteral(s, m.index + m[0].length - 1);
    if (lit) keys.add(lit[0]);
  }
  // Labels passed through t() later (constants like { label: 'General' }).
  const re2 = /\b(?:label|desc|title): (['"])((?:\\.|(?!\1).)*)\1/g;
  while ((m = re2.exec(s))) if (f.includes('AppSettingsDialog') || f.includes('keybindings') || f.includes('Dashboard')) keys.add(m[2].replace(/\\'/g, "'"));
}
// Dashboard shortcut labels and tool texts shown through tr().
const tools = fs.readFileSync(path.join(root, 'src', 'shared', 'tools.ts'), 'utf8');
for (const m of tools.matchAll(/\b(?:label|help|name): '((?:\\.|[^'])*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
const notes = [...tools.matchAll(/notes:\s*((?:\s*(?:'(?:\\.|[^'])*'|"(?:\\.|[^"])*")\s*\+?)+)/g)];
for (const n of notes) {
  const parts = [...n[1].matchAll(/'((?:\\.|[^'])*)'|"((?:\\.|[^"])*)"/g)].map((x) => (x[1] ?? x[2]).replace(/\\\\/g, '\\').replace(/\\'/g, "'").replace(/\\"/g, '"'));
  keys.add(parts.join(''));
}

const all = [...keys].filter((k) => k.trim() && /[A-Za-z]/.test(k)).sort();
const langs = ['ar', 'es', 'fr', 'de', 'zh'];
const report = {};
for (const l of langs) {
  const file = path.join(root, 'src', 'renderer', 'locales', `${l}.ts`);
  let dict = {};
  if (fs.existsSync(file)) {
    const src = fs.readFileSync(file, 'utf8').replace(/^[\s\S]*?=\s*/, '').replace(/;\s*export default.*$/s, '').replace(/;\s*$/, '');
    dict = Function(`return (${src})`)();
  }
  report[l] = all.filter((k) => !(k in dict));
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ all, missing: report }, null, 2));
else {
  console.log(`${all.length} strings`);
  for (const l of langs) console.log(`${l}: ${report[l].length} missing`);
}
