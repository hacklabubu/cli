// Accent palette for the share card. The accent is the user's belt/rank colour
// (same hex values as the web profile's BELT_COLOR_HEX), so the card reads
// identically to hacklab.so/<handle>. Kept separate from share-card.tsx so it's
// testable without loading the satori/resvg renderer.

export const BELT_COLOR_HEX: Record<string, string> = {
  white: '#E8E8E8',
  orange: '#FF8C00',
  red: '#DC2626',
  blue: '#2563EB',
  cyan: '#06B6D4',
  yellow: '#EAB308',
  lime: '#84CC16',
  green: '#22C55E',
  pink: '#EC4899',
  purple: '#A855F7',
  black: '#FFFFFF',
}

/** Unknown / missing belt falls back to the white-belt hex (matches the web). */
export const DEFAULT_ACCENT_HEX = '#E8E8E8'

export type Accent = { solid: string; alpha: (a: number) => string }

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h
  const n = Number.parseInt(full, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/**
 * The accent for a belt/rank colour: the solid hue plus an alpha() helper that
 * reuses the original mint opacities (0.1 track, 0.18/0.38/0.62/1 heat tiers) in
 * this hue, so only the colour changes, not the relative brightness.
 */
export function accentShades(beltColor: string): Accent {
  const hex = BELT_COLOR_HEX[beltColor] ?? DEFAULT_ACCENT_HEX
  const { r, g, b } = hexToRgb(hex)
  return { solid: hex, alpha: (a) => `rgba(${r}, ${g}, ${b}, ${a})` }
}
