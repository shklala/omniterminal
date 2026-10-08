import { useState } from 'react';
import type { EnvVar } from '../../shared/types';
import { Icon } from './Icon';
import { t } from '../i18n';

export interface EnvRow extends EnvVar {
  key: number;
}

let nextKey = 1;
export function toRows(env: EnvVar[]): EnvRow[] {
  return env.map((v) => ({ ...v, key: nextKey++ }));
}

/**
 * Environment variable editor. Secret values are write-only: existing secrets show
 * "•••• stored" and are only replaced when the user types a new value.
 */
export function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  const [reveal, setReveal] = useState<Set<number>>(new Set());
  const update = (key: number, patch: Partial<EnvRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const nameInvalid = (n: string) => n !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n);

  return (
    <div className="env-editor">
      {rows.length > 0 && (
        <div className="env-row env-head">
          <span>{t('Name')}</span>
          <span>{t('Value')}</span>
          <span title="Secret values are encrypted with Windows DPAPI and never shown again">{t('Secret')}</span>
          <span />
        </div>
      )}
      {rows.map((r) => (
        <div className="env-row" key={r.key}>
          <input
            className={nameInvalid(r.name) ? 'invalid' : ''}
            placeholder="NAME"
            value={r.name}
            spellCheck={false}
            onChange={(e) => update(r.key, { name: e.target.value.trim() })}
          />
          <div className="env-value">
            <input
              type={r.secret && !reveal.has(r.key) ? 'password' : 'text'}
              placeholder={r.secret ? (r.hasValue ? '•••••••• stored (type to replace)' : 'enter secret value') : 'value'}
              value={r.value}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => update(r.key, { value: e.target.value })}
            />
            {r.secret && r.value && (
              <button
                className="icon-btn small"
                type="button"
                title={t('Show/hide while typing')}
                onClick={() => setReveal((s) => {
                  const n = new Set(s);
                  if (n.has(r.key)) n.delete(r.key);
                  else n.add(r.key);
                  return n;
                })}
              >
                <Icon name="eye" size={14} />
              </button>
            )}
          </div>
          <label className="switch" title={t('Store encrypted (DPAPI); never displayed or exported')}>
            <input type="checkbox" checked={r.secret} onChange={(e) => update(r.key, { secret: e.target.checked })} />
            <span className="slider" />
          </label>
          <button className="icon-btn small" type="button" title={t('Remove')} onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      <button className="btn btn-ghost" type="button" onClick={() => onChange([...rows, { key: nextKey++, name: '', value: '', secret: false }])}>
        <Icon name="plus" size={14} /> {t('Add variable')}
      </button>
    </div>
  );
}

export function rowsToEnv(rows: EnvRow[]): EnvVar[] {
  return rows.filter((r) => r.name.trim()).map(({ name, value, secret }) => ({ name: name.trim(), value, secret }));
}
