// UI translations. English source text is the key, so anything not translated falls back to English.
// Interpolation: t('Delete "{name}"?', { name }). Dictionaries live in ./locales; run
// `node scripts/i18n-keys.mjs` to see which strings a language is missing.

import AR from './locales/ar';
import DE from './locales/de';
import ES from './locales/es';
import FR from './locales/fr';
import ZH from './locales/zh';

export type Lang = 'en' | 'ar' | 'es' | 'fr' | 'de' | 'zh';

export const LANGUAGES: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'ar', label: 'العربية' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'zh', label: '简体中文' },
];

const DICTS: Partial<Record<Lang, Record<string, string>>> = { ar: AR, es: ES, fr: FR, de: DE, zh: ZH };
const HTML_LANG: Record<Lang, string> = { en: 'en', ar: 'ar', es: 'es', fr: 'fr', de: 'de', zh: 'zh-CN' };

let current: Lang = 'en';

export function getLanguage(): Lang {
  return current;
}

/** Sets the UI language, including document direction (Arabic is right-to-left). */
export function setLanguage(lang: string): void {
  current = LANGUAGES.some((l) => l.id === lang) ? (lang as Lang) : 'en';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = HTML_LANG[current];
    document.documentElement.dir = current === 'ar' ? 'rtl' : 'ltr';
  }
}

export function t(text: string, vars?: Record<string, string | number>): string {
  let out = DICTS[current]?.[text] ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}
