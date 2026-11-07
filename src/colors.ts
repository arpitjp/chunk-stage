import { Action } from './plan';

export type ThemeKey = 'dark' | 'light' | 'highContrast' | 'highContrastLight';

/**
 * Highlight colors per action: the color id the main extension contributes in
 * package.json, and its defaults. The companion contributes no colors, so both
 * read the defaults from here.
 */
export const HIGHLIGHT_COLORS: Record<Action, { id: string; defaults: Record<ThemeKey, string> }> = {
  stage: {
    id: 'chunkStage.stagedLinesBackground',
    defaults: { dark: '#2fbf6b3d', light: '#1f9d552b', highContrast: '#3fdc8466', highContrastLight: '#0e7a3d4d' },
  },
  unstage: {
    id: 'chunkStage.unstagedLinesBackground',
    defaults: { dark: '#f5525a38', light: '#cf222e26', highContrast: '#ff6b7066', highContrastLight: '#a40e2647' },
  },
};

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parses `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. */
export function parseColor(value: unknown): Rgba | undefined {
  if (typeof value !== 'string' || !/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    return undefined;
  }
  let hex = value.slice(1);
  if (hex.length <= 4) {
    hex = [...hex].map((c) => c + c).join('');
  }
  const channel = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) / 255 : 1 };
}
