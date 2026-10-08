import { useEffect, useState } from 'react';
import type { AccountInfo, Profile } from '../../shared/types';
import { bridge, errorMessage } from '../api';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

/** "Who am I": the account each tool in this terminal is signed in to. */
export function AccountsDialog({ profile, onClose, onOpenTools }: { profile: Profile; onClose: () => void; onOpenTools: () => void }) {
  const [list, setList] = useState<AccountInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { busy: boolean; output?: string }>>({});

  useEffect(() => {
    bridge
      .invoke<AccountInfo[]>('profiles.accounts', { id: profile.id })
      .then(setList)
      .catch((e) => setError(errorMessage(e)));
  }, [profile.id]);

  const check = async (toolId: string) => {
    setChecks((c) => ({ ...c, [toolId]: { busy: true } }));
    try {
      const output = await bridge.invoke<string>('profiles.whoami', { id: profile.id, toolId });
      setChecks((c) => ({ ...c, [toolId]: { busy: false, output: output || t('(no output)') } }));
    } catch (e) {
      setChecks((c) => ({ ...c, [toolId]: { busy: false, output: errorMessage(e) } }));
    }
  };

  const signedIn = list?.filter((a) => a.account || a.tokens.length) ?? [];
  const others = list?.filter((a) => !a.account && !a.tokens.length) ?? [];

  return (
    <Dialog
      title={t('Accounts in {name}', { name: profile.name })}
      subtitle={t('Read from this terminal\'s own config folders. Other terminals are not affected.')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onOpenTools}><Icon name="settings" size={14} /> {t('Tools and tokens…')}</button>
          <button className="btn btn-primary" onClick={onClose}>{t('Close')}</button>
        </>
      }
    >
      {error && <div className="form-error">{error}</div>}
      {!list && !error && <p className="hint">{t('Reading…')}</p>}
      {list && (
        <div className="accounts">
          {signedIn.length === 0 && <p className="hint">{t('No tool in this terminal is signed in yet. Sign in inside the terminal (for example claude, gh auth login or gcloud auth login) and it shows up here.')}</p>}
          {[...signedIn, ...others].map((a) => {
            const c = checks[a.toolId];
            return (
              <div key={a.toolId} className="account-row">
                <div className="account-main">
                  <span className="account-tool">{a.toolName}</span>
                  <span className={a.account ? 'account-name' : 'account-none'} dir="auto">
                    {a.account ?? (a.tokens.length ? t('Uses a token') : t('Not signed in'))}
                  </span>
                  {a.tokens.map((tk) => (
                    <span key={tk} className="badge iso-full" title={t('Stored encrypted for this terminal only')}><Icon name="lock" size={10} /> {tk}</span>
                  ))}
                  {a.whoami && (
                    <button className="btn btn-sm btn-ghost" disabled={c?.busy} onClick={() => void check(a.toolId)} title={a.whoami}>
                      {c?.busy ? t('Checking…') : t('Check with {cmd}', { cmd: a.whoami.split(' ')[0] })}
                    </button>
                  )}
                </div>
                {c?.output && <pre className="account-output">{c.output}</pre>}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
