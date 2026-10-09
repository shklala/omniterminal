import { useEffect, useState } from 'react';
import { bridge, errorMessage } from '../api';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

/**
 * Windows Hibernate: memory is written to disk and the PC powers off. When it is turned on again,
 * every terminal and every program in it (Claude Code mid-answer, admin shells, servers) continues
 * exactly where it was. OmniTerminal saves every screen first, in case power is lost meanwhile.
 */
export function HibernateDialog({ onClose, toast }: { onClose: () => void; toast: (m: string, tone?: 'info' | 'error') => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bridge.hibernateStatus().then(setEnabled).catch(() => setEnabled(false));
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const ok = await bridge.enableHibernate();
      setEnabled(ok);
      if (!ok) toast(t('Hibernation was not turned on (the permission prompt was cancelled or declined).'), 'error');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('Hibernate this PC')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          {enabled === false && (
            <button className="btn" disabled={busy} onClick={() => void enable()}>
              <Icon name="shield" size={14} /> {busy ? t('Waiting for Windows…') : t('Turn on hibernation (Windows asks)')}
            </button>
          )}
          <button className="btn btn-primary" disabled={!enabled || busy} onClick={() => void bridge.hibernate()}>
            <Icon name="power" size={14} /> {t('Hibernate now')}
          </button>
        </>
      }
    >
      <p>
        {t('Windows saves everything in memory to disk and turns the PC off. When you turn it on again, even days later, every terminal continues exactly where it was: Claude Code in the middle of a conversation, programs that were running, administrator terminals, all of it.')}
      </p>
      <p className="hint">{t('OmniTerminal saves every screen first, so if the battery runs out while the PC is hibernated, your terminals still reopen with their output.')}</p>
      {enabled === false && (
        <div className="setup-box">
          <p className="hint">{t('Hibernation is turned off on this PC. Turning it on uses disk space about the size of your memory, and Windows asks for permission once.')}</p>
        </div>
      )}
    </Dialog>
  );
}
