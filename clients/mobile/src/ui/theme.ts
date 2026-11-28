import { Platform } from 'react-native';

/** The palette of the game's web app (apps/web/src/ui/styles.css), so the two read as one product. */
export const C = {
  bg: '#14111d',
  panel: '#1b1726',
  panelHi: '#221c30',
  edge: '#4a3d66',
  edgeDark: '#241a2e',
  ink: '#241a2e',
  text: '#f1e6cf',
  muted: '#b9ab93',
  faint: '#7d7189',
  amber: '#f2b84b',
  amberDim: '#8a6a2c',
  teal: '#5fc9b5',
  red: '#e0605a',
  hp: '#e0605a',
  mp: '#5b8def',
  ap: '#5fc9b5',
  xp: '#f2b84b',
  warrior: '#d9534f',
  mage: '#5b8def',
  rogue: '#5fbf6b',
  cleric: '#e8c35a',
  trough: '#0e0b14',
} as const;

export const CLASS_COLOR: Record<string, string> = {
  warrior: C.warrior,
  mage: C.mage,
  rogue: C.rogue,
  cleric: C.cleric,
};

export const STATUS_COLOR: Record<string, string> = {
  playing: C.teal,
  thinking: C.amber,
  resting: C.mage,
  paused: C.muted,
  fallen: C.red,
  blocked: C.red,
};

export const FONT = {
  sans: Platform.select({
    web: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans CJK JP', sans-serif",
    default: undefined,
  }),
  serif: Platform.select({
    web: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', 'Noto Serif', 'Songti SC', 'Noto Serif CJK SC', 'Hiragino Mincho ProN', serif",
    ios: 'Georgia',
    android: 'serif',
    default: undefined,
  }),
  mono: Platform.select({
    web: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Noto Sans Mono', monospace",
    ios: 'Menlo',
    android: 'monospace',
    default: undefined,
  }),
};

export const SPACE = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;
