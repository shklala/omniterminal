import { useEffect, useState } from 'react';
import { THEME_COLOR_KEYS, type CustomTheme, type ThemeColorKey } from '../../shared/types';
import { bridge, errorMessage } from '../api';
import { t } from '../i18n';
import { THEMES, getCustomThemes, themeColors } from '../themes';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

const COLOR_LABELS: Record<ThemeColorKey, string> = {
  background: 'Background',
  foreground: 'Text',
  cursor: 'Cursor',
  selectionBackground: 'Selection',
  black: 'Black',
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
  magenta: 'Magenta',
  cyan: 'Cyan',
  white: 'White',
  brightBlack: 'Bright black',
  brightRed: 'Bright red',
  brightGreen: 'Bright green',
  brightYellow: 'Bright yellow',
  brightBlue: 'Bright blue',
  brightMagenta: 'Bright magenta',
  brightCyan: 'Bright cyan',
  brightWhite: 'Bright white',
};

/** Create or edit a custom terminal theme: all 20 colours plus an optional background picture. */
export function ThemeEditor({
  theme,
  startFrom,
  onSaved,
  onDeleted,
  onClose,
}: {
  theme: CustomTheme | null;
  startFrom: string;
  onSaved: (theme: CustomTheme) => void;
  onDeleted?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(theme?.name ?? t('My theme'));
  const [colors, setColors] = useState<Record<ThemeColorKey, string>>(theme ? { ...theme.colors } : themeColors(startFrom));
  const [image, setImage] = useState(theme?.backgroundImage ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(theme?.imageOpacity ?? 0.3);
  const [fit, setFit] = useState<CustomTheme['imageFit']>(theme?.imageFit ?? 'cover');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    if (!image) {
      setImageUrl(null);
      return;
    }
    void bridge.themeImageUrl(image).then((u) => live && setImageUrl(u));
    return () => {
      live = false;
    };
  }, [image]);

  const pickImage = async () => {
    try {
      const name = await bridge.pickThemeImage();
      if (name) setImage(name);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await bridge.invoke<CustomTheme>('themes.save', {
        theme: { id: theme?.id, name, colors, backgroundImage: image, imageOpacity: opacity, imageFit: fit },
      });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!theme) return;
    await bridge.invoke('themes.delete', { id: theme.id });
    onDeleted?.();
    onClose();
  };

  const veil = hexToRgba(colors.background, 1 - opacity);
  const previewStyle: React.CSSProperties = {
    backgroundColor: colors.background,
    color: colors.foreground,
    backgroundImage: imageUrl ? `linear-gradient(${veil}, ${veil}), url("${imageUrl}")` : undefined,
    backgroundSize: fit === 'tile' ? 'auto, auto' : `100% 100%, ${fit}`,
    backgroundRepeat: fit === 'tile' ? 'repeat' : 'no-repeat',
    backgroundPosition: 'center',
  };
  const c = (k: ThemeColorKey) => ({ color: colors[k] });

  return (
    <Dialog
      wide
      title={theme ? t('Edit theme') : t('New theme')}
      subtitle={t('Themes you make here can be used by any terminal.')}
      onClose={onClose}
      footer={
        <>
          {theme && (
            <button className="btn btn-danger-ghost" style={{ marginInlineEnd: 'auto' }} onClick={remove}>
              <Icon name="trash" size={14} /> {t('Delete theme')}
            </button>
          )}
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{t('Save theme')}</button>
        </>
      }
    >
      <div className="theme-editor">
        <div className="theme-form">
          <div className="form-grid">
            <label className="field">
              <span>{t('Name')}</span>
              <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('Start from')}</span>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) setColors(themeColors(e.target.value));
                }}
              >
                <option value="">{t('Copy colours from…')}</option>
                {THEMES.map((th) => <option key={th.id} value={th.id}>{th.label}</option>)}
                {getCustomThemes().filter((x) => x.id !== theme?.id).map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
              </select>
            </label>
          </div>

          <h4 className="tool-group">{t('Colours')}</h4>
          <div className="color-grid">
            {THEME_COLOR_KEYS.map((k) => (
              <label key={k} className="color-field" title={colors[k]}>
                <input type="color" value={colors[k]} onChange={(e) => setColors((s) => ({ ...s, [k]: e.target.value }))} />
                <span>{t(COLOR_LABELS[k])}</span>
              </label>
            ))}
          </div>

          <h4 className="tool-group">{t('Background image')}</h4>
          <div className="row-actions">
            <button className="btn" type="button" onClick={pickImage}>
              <Icon name="folder" size={14} /> {image ? t('Change image…') : t('Choose image…')}
            </button>
            {image && (
              <button className="btn btn-ghost" type="button" onClick={() => setImage('')}>
                {t('Remove image')}
              </button>
            )}
          </div>
          {image && (
            <div className="form-grid" style={{ marginTop: 12 }}>
              <label className="field">
                <span>{t('Image visibility')}: {Math.round(opacity * 100)}%</span>
                <input type="range" min={5} max={100} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(Number(e.target.value) / 100)} />
              </label>
              <label className="field">
                <span>{t('Image fit')}</span>
                <select value={fit} onChange={(e) => setFit(e.target.value as CustomTheme['imageFit'])}>
                  <option value="cover">{t('Fill (crop to fit)')}</option>
                  <option value="contain">{t('Fit (show whole image)')}</option>
                  <option value="tile">{t('Tile')}</option>
                </select>
              </label>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="theme-preview-pane">
          <div className="theme-live" style={previewStyle}>
            <div><span style={c('green')}>omar@workstation</span> <span style={c('blue')}>~/projects/atlas</span> <span style={c('magenta')}>(main)</span></div>
            <div>$ git status</div>
            <div>On branch <span style={c('cyan')}>main</span></div>
            <div style={c('red')}>    modified:   src/app.ts</div>
            <div style={c('green')}>    new file:   src/theme.ts</div>
            <div>$ npm test</div>
            <div><span style={c('green')}>✓</span> 86 passed <span style={c('yellow')}>2 skipped</span></div>
            <div style={c('brightBlack')}># comments look like this</div>
            <div><span style={{ background: `${colors.selectionBackground}99` }}>selected text</span> and normal text<span className="theme-cursor" style={{ background: colors.cursor }} /></div>
            <div className="theme-swatches">
              {(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as ThemeColorKey[]).map((k) => (
                <span key={k} style={{ background: colors[k] }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${Math.max(0, Math.min(1, alpha))})`;
}
