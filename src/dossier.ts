import { formatTokens } from './scanners/util.js'
import { bold, dim, link, padEndTo, stripControl } from './ui.js'

// The agent profile (GET /api/hackers/:handle?format=agent). Shared human
// view for `hacklab profile` and `hacklab hacker <user>` — a document, not a
// card. JSON consumers still get this object as the --json envelope.

export type AgentProfile = {
  handle: string
  displayName: string | null
  bio: string | null
  url: string
  joinedAt: string
  claimedAt: string | null
  openToWork: boolean
  belt: {
    level: number
    title: string
    color: string
  }
  xp: {
    pyro: number
    hacker: number
    mason: number
    total: number
  }
  tokens: {
    total: number
    last30Days: number
    estimatedCostUsd: number
    byModel: Record<string, number>
  }
  rank: number | null
  streak: {
    current: number
    longest: number
  }
  stats: {
    projects: number
    essays: number
    drops: number
    followers: number
    following: number
  }
  skills: {
    class: string
    skill: string
    level: number
  }[]
  links: {
    profile: string
    website: string | null
    github: string | null
    x: string | null
    linkedin: string | null
    youtube: string | null
    instagram: string | null
    blog: string | null
  }
  recent: {
    projects: { title: string; description: string | null }[]
    essays: { title: string; publishedAt: string | null }[]
    drops: { text: string; createdAt: string }[]
  }
}

const LINK_ORDER = [
  'website',
  'github',
  'x',
  'linkedin',
  'youtube',
  'instagram',
  'blog',
] as const

const LABEL_WIDTH = 9

export function agentProfilePath(handle: string): string {
  return `/api/hackers/${encodeURIComponent(handle)}?src=cli&format=agent`
}

function ymd(iso: string): string {
  return iso.slice(0, 10)
}

function labelled(label: string, value: string): string {
  return `${dim(padEndTo(label, LABEL_WIDTH))}  ${value}`
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function skillLine(items: { skill: string; level: number }[]): string {
  return items.map((s) => `${stripControl(s.skill)} ${s.level}`).join('  ')
}

export function renderDossier(
  profile: AgentProfile,
  opts: { self?: boolean; appUrl?: string } = {}
): string[] {
  const lines: string[] = []
  const handle = stripControl(profile.handle)
  const name = profile.displayName
    ? stripControl(profile.displayName).trim()
    : ''

  const identity: string[] = []
  if (name) identity.push(bold(name))
  identity.push(dim(`@${handle}`))
  identity.push(
    dim(`L${profile.belt.level} ${stripControl(profile.belt.title)}`)
  )
  if (profile.rank != null) identity.push(dim(`rank #${profile.rank}`))
  if (profile.openToWork) identity.push('open to work')
  lines.push(identity.join('  '))

  const bio = profile.bio ? stripControl(profile.bio).trim() : ''
  if (bio) {
    lines.push('')
    lines.push(bio)
  }

  const stats: string[] = []
  if (profile.tokens.total > 0) {
    const parts = [
      `${formatTokens(profile.tokens.total)} total`,
      `${formatTokens(profile.tokens.last30Days)} last 30d`,
    ]
    if (profile.tokens.estimatedCostUsd > 0) {
      parts.push(usd(profile.tokens.estimatedCostUsd))
    }
    stats.push(labelled('tokens', parts.join('  ·  ')))
  }
  if (profile.streak.current > 0 || profile.streak.longest > 0) {
    stats.push(
      labelled(
        'streak',
        `${profile.streak.current}d current  ·  ${profile.streak.longest}d longest`
      )
    )
  }
  if (profile.xp.total > 0) {
    stats.push(
      labelled(
        'xp',
        `pyro ${formatTokens(profile.xp.pyro)}  ·  hacker ${formatTokens(profile.xp.hacker)}  ·  mason ${formatTokens(profile.xp.mason)}`
      )
    )
  }
  if (profile.stats.followers > 0 || profile.stats.following > 0) {
    stats.push(
      labelled(
        'follows',
        `${profile.stats.followers} followers  ·  ${profile.stats.following} following`
      )
    )
  }
  if (stats.length > 0) {
    lines.push('')
    lines.push(...stats)
  }

  const linkRows: string[] = []
  for (const key of LINK_ORDER) {
    const href = profile.links[key]
    if (!href) continue
    linkRows.push(labelled(key, link(stripControl(href))))
  }
  if (linkRows.length > 0) {
    lines.push('')
    lines.push(...linkRows)
  }

  const languages = profile.skills.filter((s) => s.class === 'hacker')
  const tools = profile.skills.filter((s) => s.class === 'pyro')
  const skillRows: string[] = []
  if (languages.length > 0)
    skillRows.push(labelled('skills', skillLine(languages)))
  if (tools.length > 0) skillRows.push(labelled('tools', skillLine(tools)))
  const models = Object.entries(profile.tokens.byModel)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  if (models.length > 0) {
    skillRows.push(
      labelled(
        'models',
        models
          .map(([m, n]) => `${stripControl(m)} ${formatTokens(n)}`)
          .join('  ')
      )
    )
  }
  if (skillRows.length > 0) {
    lines.push('')
    lines.push(...skillRows)
  }

  if (profile.stats.projects > 0) {
    lines.push('')
    lines.push(`${dim('projects')} ${profile.stats.projects}`)
    for (const p of profile.recent.projects) {
      lines.push(`  ${stripControl(p.title)}`)
      const desc = p.description ? stripControl(p.description).trim() : ''
      if (desc) lines.push(`    ${desc}`)
    }
  }

  if (profile.stats.essays > 0) {
    lines.push('')
    lines.push(`${dim('essays')} ${profile.stats.essays}`)
    for (const e of profile.recent.essays) {
      const title = stripControl(e.title)
      lines.push(
        e.publishedAt ? `  ${ymd(e.publishedAt)}  ${title}` : `  ${title}`
      )
    }
  }

  if (profile.stats.drops > 0) {
    lines.push('')
    lines.push(`${dim('drops')} ${profile.stats.drops}`)
    for (const d of profile.recent.drops) {
      lines.push(`  ${ymd(d.createdAt)}  ${stripControl(d.text)}`)
    }
  }

  const url = opts.appUrl
    ? `${opts.appUrl.replace(/\/$/, '')}/${handle}`
    : stripControl(profile.url || profile.links.profile)
  if (url) {
    lines.push('')
    lines.push(link(url))
  }

  if (opts.self) {
    lines.push('')
    lines.push(dim('hacklab profile set <field> <value>'))
  }

  return lines
}
