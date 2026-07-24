import { execSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import satori from 'satori'
import { type Accent, accentShades } from './share-card-colors.js'

// ── Design tokens (DESIGN.md) ──────────────────────────────────────────────
// The accent is the user's belt/rank colour (same palette as the web profile),
// so the card reads identically to hacklab.so/<handle>. It's the one signal
// colour: corner brackets, the belt + proficiency bars, and the lit heatmap
// cells. Everything else is neutral graphite + grey. Numbers + the nametag are
// Orbitron; every other glyph is JetBrains Mono.
const PAGE_BG = '#0B0D0C'
const CARD_BG = '#101513'
const BORDER = '#1D221F'
const WHITE = '#FFFFFF'
const LABEL = '#B4B4B4'
const LABEL_DIM = '#9A9A9A'
const FOOTER_FG = '#8A8A8A'

// Activity heatmap: 26 weeks × 7 days, matching the web profile (column = week,
// row = day-of-week), so the CLI card and the site read identically.
const HEAT_COLS = 26
const HEAT_ROWS = 7
const HEAT_CELL = 14
const HEAT_GAP = 3

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

// Fold a raw model id into a short display label, keeping the version:
//   "claude-opus-4-1-20250805" → "OPUS 4.1"
//   "claude-3-5-sonnet-latest" → "SONNET 3.5"
//   "gpt-5.3-codex"            → "GPT-5.3-CODEX"
export function shortModelName(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (!s) return ''
  // Drop a trailing release date (…-20250805) so it doesn't crowd the label.
  const t = s.replace(/[-_]?\d{8}$/, '')
  const tier = t.includes('opus')
    ? 'opus'
    : t.includes('sonnet')
      ? 'sonnet'
      : t.includes('haiku')
        ? 'haiku'
        : null
  if (tier) {
    const ver = t
      .split(/[-_.\s]+/)
      .filter((p) => /^\d+$/.test(p))
      .slice(0, 2)
      .join('.')
    return (ver ? `${tier} ${ver}` : tier).toUpperCase()
  }
  return t.toUpperCase().slice(0, 16)
}

export type ShareCardData = {
  handle: string
  level: number
  title: string
  beltColor: string
  tokensTotal: number
  rank: number
  streak: number
  longestStreak: number
  progressPercent: number
  estimatedCost: number
  followers?: number
  avatarUrl?: string
  toolBreakdown: {
    claudeCode: number
    codex: number
    cursor: number
  }
  models: Array<{ name: string; tokens: number }>
  dailyActivity: Array<{ date: string; tokens: number }>
}

// ── Heatmap ─────────────────────────────────────────────────────────────────
// Opacity per intensity tier (0 = empty), matching the web's 18/38/62/100% mix.
const TIER_OPACITY = [0, 0.18, 0.38, 0.62, 1] as const

// Build the HEAT_ROWS × HEAT_COLS grid from real daily usage. Mirrors the web
// profile's buildRecentWeeks: columns are the latest 26 weeks ending on the
// Saturday on/after today, rows are Sun→Sat, intensity bucketed vs the window
// max. matrix[day][week] holds the tier for that date.
function buildMatrix(
  daily: Array<{ date: string; tokens: number }>
): number[][] {
  const perDay = new Map<string, number>()
  for (const e of daily) {
    perDay.set(e.date, (perDay.get(e.date) ?? 0) + e.tokens)
  }

  const today = new Date()
  const gridEnd = new Date(today)
  gridEnd.setUTCDate(today.getUTCDate() + (6 - today.getUTCDay()))
  const gridStart = new Date(gridEnd)
  gridStart.setUTCDate(gridEnd.getUTCDate() - HEAT_COLS * 7 + 1)

  const values: number[][] = []
  let max = 0
  for (let d = 0; d < HEAT_ROWS; d++) {
    const row: number[] = []
    for (let w = 0; w < HEAT_COLS; w++) {
      const date = new Date(gridStart)
      date.setUTCDate(gridStart.getUTCDate() + w * 7 + d)
      const v = perDay.get(date.toISOString().slice(0, 10)) ?? 0
      row.push(v)
      if (v > max) max = v
    }
    values.push(row)
  }

  return values.map((row) =>
    row.map((v) => {
      if (v <= 0 || max === 0) return 0
      const r = v / max
      return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1
    })
  )
}

function Heatmap({ matrix, accent }: { matrix: number[][]; accent: Accent }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: HEAT_GAP }}>
      {matrix.map((row) => (
        // biome-ignore lint/correctness/useJsxKeyInIterable: satori has no keys
        <div style={{ display: 'flex', gap: HEAT_GAP }}>
          {row.map((tier) =>
            tier === 0 ? (
              // Empty slot: a tiny centred dot, not a full cell.
              // biome-ignore lint/correctness/useJsxKeyInIterable: satori has no keys
              <div
                style={{
                  display: 'flex',
                  width: HEAT_CELL,
                  height: HEAT_CELL,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    width: 3,
                    height: 3,
                    backgroundColor: accent.alpha(0.35),
                  }}
                />
              </div>
            ) : (
              // biome-ignore lint/correctness/useJsxKeyInIterable: satori has no keys
              <div
                style={{
                  display: 'flex',
                  width: HEAT_CELL,
                  height: HEAT_CELL,
                  backgroundColor: accent.alpha(TIER_OPACITY[tier] ?? 0),
                }}
              />
            )
          )}
        </div>
      ))}
    </div>
  )
}

// ── Proficiency bar: solid mint fill over a 10%-mint track. ──────────────────
function Bar({ pct, accent }: { pct: number; accent: Accent }) {
  const fill = Math.max(0, Math.min(100, pct))
  return (
    <div
      style={{
        display: 'flex',
        width: 64,
        height: 6,
        backgroundColor: accent.alpha(0.1),
      }}
    >
      <div
        style={{
          display: 'flex',
          height: 6,
          width: `${fill}%`,
          backgroundColor: accent.solid,
        }}
      />
    </div>
  )
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        justifyContent: 'center',
        backgroundColor: CARD_BG,
        border: `1px solid ${BORDER}`,
        paddingLeft: 16,
        gap: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          fontFamily: 'Orbitron',
          fontWeight: 700,
          fontSize: 33,
          lineHeight: 1,
          letterSpacing: 0.5,
          color: WHITE,
        }}
      >
        {value}
      </div>
      <div
        style={{
          display: 'flex',
          fontSize: 16,
          letterSpacing: 2,
          color: LABEL,
        }}
      >
        {label}
      </div>
    </div>
  )
}

function PillStat({ value, label }: { value: string; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: CARD_BG,
        border: `1px solid ${BORDER}`,
        paddingLeft: 17,
        paddingRight: 17,
      }}
    >
      <div
        style={{
          display: 'flex',
          fontFamily: 'Orbitron',
          fontWeight: 700,
          fontSize: 20,
          letterSpacing: 0.5,
          color: WHITE,
        }}
      >
        {value}
      </div>
      <div
        style={{
          display: 'flex',
          fontSize: 16,
          letterSpacing: 2,
          color: LABEL,
        }}
      >
        {label}
      </div>
    </div>
  )
}

function CornerBracket({
  pos,
  accent,
}: {
  pos: 'tl' | 'tr' | 'bl' | 'br'
  accent: Accent
}) {
  const arm = 11
  const thick = 2
  const inset = 0
  const vert = pos[0] === 't' ? 'top' : 'bottom'
  const horiz = pos[1] === 'l' ? 'left' : 'right'
  return (
    <div
      style={{
        display: 'flex',
        position: 'absolute',
        width: arm,
        height: arm,
        [vert]: inset,
        [horiz]: inset,
        [`border${vert === 'top' ? 'Top' : 'Bottom'}`]: `${thick}px solid ${accent.solid}`,
        [`border${horiz === 'left' ? 'Left' : 'Right'}`]: `${thick}px solid ${accent.solid}`,
      }}
    />
  )
}

function ShareCard({
  data,
  matrix,
  avatar,
}: {
  data: ShareCardData
  matrix: number[][]
  avatar: string | null
}) {
  const models = data.models.slice(0, 4)
  const modelMax = models.length > 0 ? (models[0]?.tokens ?? 1) : 1
  const cost = Math.round(data.estimatedCost).toLocaleString('en-US')
  const progress = Math.max(0, Math.min(100, data.progressPercent))
  const initial = (data.handle[0] ?? '?').toUpperCase()
  const accent = accentShades(data.beltColor)

  return (
    <div
      style={{
        position: 'relative',
        width: 800,
        height: 500,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: PAGE_BG,
        padding: 16,
        fontFamily: 'JetBrains Mono',
        color: WHITE,
      }}
    >
      <CornerBracket pos='tl' accent={accent} />
      <CornerBracket pos='tr' accent={accent} />
      <CornerBracket pos='bl' accent={accent} />
      <CornerBracket pos='br' accent={accent} />

      {/* Header */}
      <div
        style={{
          display: 'flex',
          height: 70,
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: CARD_BG,
          border: `1px solid ${BORDER}`,
          paddingLeft: 12,
          paddingRight: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div
            style={{
              display: 'flex',
              width: 46,
              height: 46,
              border: `1px solid ${BORDER}`,
              backgroundColor: '#0C100E',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {avatar ? (
              // biome-ignore lint/performance/noImgElement: satori rasterises to SVG, not a DOM img
              <img src={avatar} width={46} height={46} alt='' />
            ) : (
              <div
                style={{
                  display: 'flex',
                  fontFamily: 'Orbitron',
                  fontWeight: 700,
                  fontSize: 22,
                  color: accent.solid,
                }}
              >
                {initial}
              </div>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              fontFamily: 'Orbitron',
              fontWeight: 700,
              fontSize: 20,
              letterSpacing: 0.5,
              color: WHITE,
            }}
          >
            @{data.handle.toUpperCase()}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              display: 'flex',
              fontFamily: 'Orbitron',
              fontWeight: 700,
              fontSize: 17,
              letterSpacing: 1,
              color: WHITE,
            }}
          >
            L{data.level}
          </div>
          <div
            style={{
              display: 'flex',
              width: 104,
              height: 8,
              backgroundColor: accent.alpha(0.1),
            }}
          >
            <div
              style={{
                display: 'flex',
                width: `${progress}%`,
                height: 8,
                backgroundColor: accent.solid,
              }}
            />
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'flex', height: 114, gap: 26, marginTop: 18 }}>
        <StatCard
          value={formatTokens(data.tokensTotal)}
          label='TOKENS BURNED'
        />
        <StatCard value={`${data.streak}D`} label='STREAK' />
        <StatCard value={`$${cost}`} label='EST. COST' />
      </div>

      {/* Models + heatmap */}
      <div style={{ display: 'flex', height: 142, gap: 18, marginTop: 18 }}>
        <div
          style={{
            display: 'flex',
            width: 284,
            flexDirection: 'column',
            justifyContent: 'center',
            backgroundColor: CARD_BG,
            border: `1px solid ${BORDER}`,
            paddingLeft: 17,
            paddingRight: 17,
            gap: 14,
          }}
        >
          {models.map((m) => (
            // biome-ignore lint/correctness/useJsxKeyInIterable: satori has no keys
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  fontSize: 15,
                  letterSpacing: 0.4,
                  color: LABEL_DIM,
                }}
              >
                {shortModelName(m.name)}
              </div>
              <Bar pct={(m.tokens / modelMax) * 100} accent={accent} />
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: CARD_BG,
            border: `1px solid ${BORDER}`,
          }}
        >
          <Heatmap matrix={matrix} accent={accent} />
        </div>
      </div>

      {/* Pill stats */}
      <div style={{ display: 'flex', height: 42, gap: 17, marginTop: 18 }}>
        <PillStat value={`${data.longestStreak}D`} label='BEST STREAK' />
        <PillStat value={`#${data.rank}`} label='RANK' />
        <PillStat value={String(data.followers ?? 0)} label='FOLLOWERS' />
      </div>

      {/* Footer */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 'auto',
          paddingLeft: 2,
          paddingRight: 2,
        }}
      >
        <div style={{ display: 'flex', fontSize: 15, color: FOOTER_FG }}>
          hacklab.so/{data.handle}
        </div>
        <div style={{ display: 'flex', fontSize: 15, color: FOOTER_FG }}>
          #sweatysunday
        </div>
      </div>
    </div>
  )
}

// ── Font loading (disk-cached so repeat renders are offline + fast) ──────────
const FONT_SOURCES: Record<string, string> = {
  'orbitron-700.woff':
    'https://cdn.jsdelivr.net/fontsource/fonts/orbitron@latest/latin-700-normal.woff',
  'jetbrains-400.woff':
    'https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.woff',
  'jetbrains-500.woff':
    'https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-500-normal.woff',
}

async function loadFont(name: string): Promise<ArrayBuffer> {
  const dir = join(homedir(), '.hacklab', 'fonts')
  const file = join(dir, name)
  try {
    const cached = await readFile(file)
    return cached.buffer.slice(
      cached.byteOffset,
      cached.byteOffset + cached.byteLength
    ) as ArrayBuffer
  } catch {
    const url = FONT_SOURCES[name]
    if (!url) throw new Error(`unknown font: ${name}`)
    const buf = await fetch(url).then((r) => r.arrayBuffer())
    await mkdir(dir, { recursive: true })
    await writeFile(file, Buffer.from(buf))
    return buf
  }
}

async function loadAvatar(url: string | undefined): Promise<string | null> {
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? 'image/png'
    const buf = Buffer.from(await res.arrayBuffer())
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

export async function generateShareCard(data: ShareCardData): Promise<string> {
  const [orbitron700, jetbrains400, jetbrains500, avatar] = await Promise.all([
    loadFont('orbitron-700.woff'),
    loadFont('jetbrains-400.woff'),
    loadFont('jetbrains-500.woff'),
    loadAvatar(data.avatarUrl),
  ])

  const matrix = buildMatrix(data.dailyActivity)

  const svg = await satori(
    <ShareCard data={data} matrix={matrix} avatar={avatar} />,
    {
      width: 800,
      height: 500,
      fonts: [
        { name: 'Orbitron', data: orbitron700, weight: 700, style: 'normal' },
        {
          name: 'JetBrains Mono',
          data: jetbrains400,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'JetBrains Mono',
          data: jetbrains500,
          weight: 500,
          style: 'normal',
        },
      ],
    }
  )

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1600 },
  })
  const png = Buffer.from(resvg.render().asPng())

  const dir = join(homedir(), '.hacklab')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, 'share-card.png')
  await writeFile(filePath, png)

  return filePath
}

export function displayInTerminal(pngBuffer: Buffer): boolean {
  const env = process.env
  const isKitty =
    env.TERM === 'xterm-kitty' ||
    env.TERM === 'xterm-ghostty' ||
    env.KITTY_WINDOW_ID !== undefined ||
    env.TERM_PROGRAM === 'WezTerm' ||
    env.TERM_PROGRAM === 'WarpTerminal' ||
    env.KONSOLE_VERSION !== undefined
  const isITerm =
    env.TERM_PROGRAM === 'iTerm.app' ||
    env.TERM_PROGRAM === 'vscode' ||
    (!isKitty && env.TERM_PROGRAM === 'WezTerm')

  try {
    if (isKitty) {
      const base64 = pngBuffer.toString('base64')
      const chunkSize = 4096
      for (let i = 0; i < base64.length; i += chunkSize) {
        const chunk = base64.slice(i, i + chunkSize)
        const isLast = i + chunkSize >= base64.length
        if (i === 0) {
          process.stdout.write(
            `\x1b_Ga=T,f=100,m=${isLast ? 0 : 1};${chunk}\x1b\\`
          )
        } else {
          process.stdout.write(`\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`)
        }
      }
      process.stdout.write('\n')
      return true
    }
    if (isITerm) {
      const base64 = pngBuffer.toString('base64')
      const filename = Buffer.from('hacklab-card.png').toString('base64')
      process.stdout.write(
        `\x1b]1337;File=name=${filename};size=${pngBuffer.length};inline=1:${base64}\x07\n`
      )
      return true
    }
    return false
  } catch {
    return false
  }
}

export async function copyToClipboard(imagePath: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    const script = `set the clipboard to (read POSIX file "${imagePath}" as «class PNGf»)`
    execSync(`osascript -e '${script}'`, { timeout: 5000 })
    return true
  } catch {
    return false
  }
}
