import type { ITheme } from '@xterm/xterm';

export interface TerminalTheme {
  id: string;
  label: string;
  theme: ITheme;
}

export const THEMES: TerminalTheme[] = [
  {
    id: 'omni-dark',
    label: 'Omni Dark',
    theme: {
      background: '#0b0f14', foreground: '#d6dde6', cursor: '#7aa2ff', cursorAccent: '#0b0f14',
      selectionBackground: '#2b3d66aa',
      black: '#1b222c', red: '#f27878', green: '#7fd18b', yellow: '#e8c26a', blue: '#6ea0ff', magenta: '#c48cf0', cyan: '#5fd0d6', white: '#c9d1d9',
      brightBlack: '#5c6773', brightRed: '#ff9a9a', brightGreen: '#9be7a6', brightYellow: '#ffd98a', brightBlue: '#9abcff', brightMagenta: '#dcb0ff', brightCyan: '#8be6ea', brightWhite: '#ffffff',
    },
  },
  {
    id: 'campbell',
    label: 'Campbell',
    theme: {
      background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', selectionBackground: '#ffffff40',
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
    },
  },
  {
    id: 'one-half-dark',
    label: 'One Half Dark',
    theme: {
      background: '#282c34', foreground: '#dcdfe4', cursor: '#a3b3cc', selectionBackground: '#474e5d',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
      brightBlack: '#5a6374', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#dcdfe4',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    theme: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    theme: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'light',
    label: 'One Half Light',
    theme: {
      background: '#fafafa', foreground: '#383a42', cursor: '#383a42', selectionBackground: '#bfceff',
      black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#fafafa',
      brightBlack: '#4f525e', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },
];

export function getTheme(id: string): ITheme {
  return (THEMES.find((t) => t.id === id) ?? THEMES[0]).theme;
}
