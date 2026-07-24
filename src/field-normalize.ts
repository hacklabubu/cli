// Tiny value-shaping helpers shared by the profile and org field surfaces.
// Real validation lives server-side; these only make honest inputs sendable.

export const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on'])
export const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off'])

export function ensureScheme(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}
