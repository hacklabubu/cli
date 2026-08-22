import { bold, dim, info } from '../ui.js'

// `hacklab rtfm` — the manuals. The command isn't live yet: everything except
// `rtfm topics` prints a not-available-yet notice. The topics list below is the
// roadmap of manuals we're writing, shown so people (and agents) can see what's
// coming before the content lands.

type Topic = { name: string; summary: string }

// `onboarding` stands alone as the first manual a new user needs; the rest are
// task-shaped topics in the order we expect to ship them.
const TOPIC_GROUPS: Topic[][] = [
  [{ name: 'onboarding', summary: 'setup user profile from zero to live' }],
  [
    {
      name: 'wtf',
      summary: 'what hacklab is, why proof of work, how this cli maps to it',
    },
    {
      name: 'game',
      summary:
        'how game system works on hacklab, how do you get XP, what are belts and so on',
    },
    { name: 'post-job', summary: 'org owners: publish a job to the job shop' },
    {
      name: 'find-team',
      summary: 'hackathons: rsvp, browse hackers, form a team',
    },
    {
      name: 'org-setup',
      summary: 'claim or create an org, get access, invite',
    },
    {
      name: 'drop-daily',
      summary: "post a drop on the user's behalf (retention loop)",
    },
    {
      name: 'grow',
      summary:
        'identify all people in your network and invite them all with your referral link',
    },
  ],
]

export function rtfm(args: string[]): void {
  if (args[0] === 'topics') {
    printTopics()
    return
  }
  info('rtfm is not available yet — coming soon.')
  info(`run ${bold('hacklab rtfm topics')} to see what it will cover`)
}

function printTopics() {
  // Pad the names so the summaries line up, matching the `--help` layout.
  const width = Math.max(
    ...TOPIC_GROUPS.flat().map((topic) => topic.name.length)
  )
  for (const group of TOPIC_GROUPS) {
    console.log('')
    for (const { name, summary } of group) {
      console.log(`  ${dim(name.padEnd(width))}  ${summary}`)
    }
  }
  console.log('')
}
