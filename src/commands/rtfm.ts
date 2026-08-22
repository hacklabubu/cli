import { bold, dim, error, info } from '../ui.js'

type Manual = {
  name: string
  summary: string
  sections: Array<{
    heading: string
    lines: string[]
  }>
}

const MANUALS: Manual[] = [
  {
    name: 'profile-setup',
    summary: 'build a complete profile from available information',
    sections: [
      {
        heading: 'objective',
        lines: [
          "Set up the user's hacklab profile. Make it impressive and something they're proud of.",
        ],
      },
      {
        heading: 'prerequisites',
        lines: ['- Confirm authentication with `hacklab whoami`.'],
      },
      {
        heading: 'steps',
        lines: [
          '1. Run `hacklab ping` immediately.',
          '   This tells hacklab that profile setup is in progress and lets the user continue on the platform.',
          '2. Inspect the current profile with `hacklab profile --json`.',
          '3. Gather the most relevant, verifiable information about the user.',
          '4. Look for their profiles on:',
          '   - blog or personal website',
          '   - GitHub',
          '   - Hugging Face',
          '   - X (x.com)',
          '   - LinkedIn',
          '   - YouTube',
          '   - Product Hunt',
          '   - Kaggle',
          '   - Cursor (`cursor.com/@handle`)',
          '   - Dribbble',
          '   - Behance',
          '   - GitLab',
          '   - Devpost',
          '   - Replit',
          '   - itch.io',
          '   - CodePen',
          '   - Stack Overflow',
          '   - arXiv',
          '   - Google Scholar',
          '   - Substack',
          '   - Twitch',
          '   - Farcaster',
          '   - Goodreads',
          '   - Filmweb',
          '   - IMDb',
          '   - Spotify',
          '5. Run `hacklab profile set --help` to get the exact field names.',
          '6. Add every verified profile field and link:',
          '   - one field: `hacklab profile set <field> <url> --json`',
          '   - several fields: create a YAML or JSON file, then run:',
          '     `hacklab profile apply <file> --json`',
          '7. Verify the finished profile with `hacklab profile --json`.',
        ],
      },
      {
        heading: 'done when',
        lines: [
          '- The profile looks polished and complete.',
          '- The most relevant verified information available has been added.',
          '- The final state has been checked with `hacklab profile --json`.',
        ],
      },
      {
        heading: 'do not',
        lines: ['- Do not put social links in the bio or README.'],
      },
    ],
  },
]

export function rtfm(args: string[]): void {
  const topic = args[0]
  if (!topic || topic === '--help' || topic === '-h' || topic === 'help') {
    printManuals()
    return
  }

  const manual = MANUALS.find(({ name }) => name === topic)
  if (!manual) {
    error(`manual not found: ${topic}`)
    info(`run ${bold('hacklab rtfm')} to list manuals`)
    process.exit(1)
  }

  printManual(manual)
}

function printManuals(): void {
  const width = Math.max(...MANUALS.map(({ name }) => name.length))
  console.log('')
  for (const { name, summary } of MANUALS) {
    console.log(`  ${dim(name.padEnd(width))}  ${summary}`)
  }
  console.log('')
}

function printManual(manual: Manual): void {
  console.log('')
  console.log(`  ${bold(manual.name)}`)
  for (const section of manual.sections) {
    console.log('')
    console.log(`  ${bold(section.heading)}`)
    for (const line of section.lines) console.log(`    ${line}`)
  }
  console.log('')
}
