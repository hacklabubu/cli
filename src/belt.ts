// Belt / level math — ported verbatim from @hacklab/db `levels.ts` so the CLI
// can render the share card instantly (locally) without waiting on the server.
// The CLI is a standalone published package and must not pull in @hacklab/db
// (drizzle/pg/etc.), so we copy the small, stable curve here.
//
// One curve: xp(level) = 23 × level^3.32 up to level 100, exponential above.
// Pyro XP = tokens / 1000. For a brand-new account, hacker + mason XP are 0, so
// belt XP == pyro XP — which is exactly what the server computes right after
// the first sync. Kept in sync via belt.test.ts (anchored to the known points).

const K = 3.32
const A = 23
const LEVEL_100_XP = 100_000_000 // 100M XP

export type BeltColor =
  | 'white'
  | 'orange'
  | 'red'
  | 'blue'
  | 'cyan'
  | 'yellow'
  | 'lime'
  | 'green'
  | 'pink'
  | 'purple'
  | 'black'

export type Title =
  | 'gaijin'
  | 'deshi'
  | 'ronin'
  | 'shinobi'
  | 'samurai'
  | 'senpai'
  | 'tatsujin'
  | 'kensei'
  | 'oni'
  | 'ryujin'

export type DanTitle =
  | 'shodan'
  | 'nidan'
  | 'sandan'
  | 'yondan'
  | 'godan'
  | 'rokudan'
  | 'nanadan'
  | 'hachidan'
  | 'kudan'
  | 'judan'

export type GrandMasterTitle = 'shihan' | 'hanshi' | 'meijin' | 'oyama'

const BELT_TIERS: Array<{ minLevel: number; color: BeltColor; title: Title }> =
  [
    { minLevel: 0, color: 'white', title: 'gaijin' },
    { minLevel: 10, color: 'orange', title: 'deshi' },
    { minLevel: 20, color: 'red', title: 'ronin' },
    { minLevel: 30, color: 'blue', title: 'shinobi' },
    { minLevel: 40, color: 'cyan', title: 'samurai' },
    { minLevel: 50, color: 'yellow', title: 'senpai' },
    { minLevel: 60, color: 'lime', title: 'tatsujin' },
    { minLevel: 70, color: 'green', title: 'kensei' },
    { minLevel: 80, color: 'pink', title: 'oni' },
    { minLevel: 90, color: 'purple', title: 'ryujin' },
  ]

const DAN_TITLES: DanTitle[] = [
  'shodan',
  'nidan',
  'sandan',
  'yondan',
  'godan',
  'rokudan',
  'nanadan',
  'hachidan',
  'kudan',
  'judan',
]

const GRAND_MASTER_TIERS: Array<{ minLevel: number; title: GrandMasterTitle }> =
  [
    { minLevel: 200, title: 'shihan' },
    { minLevel: 300, title: 'hanshi' },
    { minLevel: 400, title: 'meijin' },
    { minLevel: 500, title: 'oyama' },
  ]

/** Convert raw token count to Pyro XP. 1,000 tokens = 1 XP. */
export function tokensToXp(tokens: number): number {
  return Math.floor(tokens / 1_000)
}

/** Convert total XP to level (fractional). */
export function xpToLevel(xp: number): number {
  if (xp <= 0) return 0
  if (xp >= LEVEL_100_XP) {
    return 100 + 100 * Math.log10(xp / LEVEL_100_XP)
  }
  return (xp / A) ** (1 / K)
}

/** Convert level to minimum XP required. */
export function levelToMinXp(level: number): number {
  if (level <= 0) return 0
  if (level >= 100) {
    return Math.round(LEVEL_100_XP * 10 ** ((level - 100) / 100))
  }
  return Math.round(A * level ** K)
}

/** Get the integer level (floor of fractional level). */
export function getLevel(xp: number): number {
  return Math.floor(xpToLevel(xp))
}

/** Get belt color for a given level. */
export function getBeltColor(level: number): BeltColor {
  if (level >= 100) return 'black'
  for (let i = BELT_TIERS.length - 1; i >= 0; i--) {
    if (level >= BELT_TIERS[i]!.minLevel) return BELT_TIERS[i]!.color
  }
  return 'white'
}

/** Get title for a given level. */
export function getTitle(level: number): Title | DanTitle | GrandMasterTitle {
  if (level >= 200) {
    for (let i = GRAND_MASTER_TIERS.length - 1; i >= 0; i--) {
      if (level >= GRAND_MASTER_TIERS[i]!.minLevel)
        return GRAND_MASTER_TIERS[i]!.title
    }
  }
  if (level >= 100) {
    const danIndex = Math.min(
      Math.floor((level - 100) / 10),
      DAN_TITLES.length - 1
    )
    return DAN_TITLES[danIndex]!
  }
  for (let i = BELT_TIERS.length - 1; i >= 0; i--) {
    if (level >= BELT_TIERS[i]!.minLevel) return BELT_TIERS[i]!.title
  }
  return 'gaijin'
}

export type BeltProgress = {
  level: number
  title: Title | DanTitle | GrandMasterTitle
  beltColor: BeltColor
  progressPercent: number
}

/** Belt info for a raw token total (pyro-only — correct for a fresh account). */
export function beltForTokens(tokensTotal: number): BeltProgress {
  const xp = tokensToXp(tokensTotal)
  const level = getLevel(xp)
  const currentLevelXp = levelToMinXp(level)
  const nextLevelXp = levelToMinXp(level + 1)
  const xpIntoLevel = xp - currentLevelXp
  const xpNeeded = nextLevelXp - currentLevelXp
  const progressPercent =
    xpNeeded > 0 ? Math.min(Math.round((xpIntoLevel / xpNeeded) * 100), 100) : 0

  return {
    level,
    title: getTitle(level),
    beltColor: getBeltColor(level),
    progressPercent,
  }
}
