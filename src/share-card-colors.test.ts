import { describe, expect, it } from 'vitest'

import {
  accentShades,
  BELT_COLOR_HEX,
  DEFAULT_ACCENT_HEX,
  hexToRgb,
} from './share-card-colors.js'

describe('hexToRgb', () => {
  it('parses 6-digit hex', () => {
    expect(hexToRgb('#2563EB')).toEqual({ r: 37, g: 99, b: 235 })
    expect(hexToRgb('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 })
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('expands 3-digit shorthand', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 })
  })
})

describe('accentShades', () => {
  it('uses the belt hue as the solid accent', () => {
    expect(accentShades('blue').solid).toBe('#2563EB')
    expect(accentShades('purple').solid).toBe('#A855F7')
    expect(accentShades('black').solid).toBe('#FFFFFF')
  })

  it('falls back to the white-belt hue for unknown belts', () => {
    expect(accentShades('chartreuse').solid).toBe(DEFAULT_ACCENT_HEX)
    expect(accentShades('').solid).toBe(DEFAULT_ACCENT_HEX)
  })

  it('alpha() applies the requested opacity to the belt hue', () => {
    const blue = accentShades('blue')
    // same opacities the mint used before, now in the belt hue
    expect(blue.alpha(0.1)).toBe('rgba(37, 99, 235, 0.1)')
    expect(blue.alpha(0.62)).toBe('rgba(37, 99, 235, 0.62)')
    expect(blue.alpha(1)).toBe('rgba(37, 99, 235, 1)')
  })

  it('covers every belt in the level curve', () => {
    for (const name of Object.keys(BELT_COLOR_HEX)) {
      expect(accentShades(name).solid).toBe(BELT_COLOR_HEX[name])
    }
  })
})
