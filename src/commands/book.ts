import { loadSession, resolveAppUrl } from '../session.js'
import { dim, error, info, success } from '../ui.js'

const TITLE_MAX = 200
const AUTHOR_MAX = 200
const TAKEAWAYS_MAX = 5000

const USAGE =
  'usage: hacklab book "Title" --author "Name" [--takeaways "what stuck with you"]'

export type BookArgs = {
  title: string
  author: string
  takeaways?: string
}

/**
 * Parse `book` args: free words become the title, `-a/--author` and
 * `-t/--takeaways` take a quoted value. Mirrors `parseDropArgs` (drop.ts) so
 * each command owns its own parsing. Deliberately no manifest file — a book is
 * three fields, and quoting them beats authoring YAML for it.
 */
export function parseBookArgs(args: string[]): BookArgs {
  let author: string | undefined
  let takeaways: string | undefined
  const words: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if ((arg === '-a' || arg === '--author') && args[i + 1] !== undefined) {
      author = args[i + 1]
      i++
    } else if (
      (arg === '-t' || arg === '--takeaways') &&
      args[i + 1] !== undefined
    ) {
      takeaways = args[i + 1]
      i++
    } else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}`)
      process.exit(1)
    } else {
      words.push(arg)
    }
  }

  const title = words.join(' ').trim()

  if (!title) {
    console.error(USAGE)
    process.exit(1)
  }

  if (!author?.trim()) {
    console.error('missing --author')
    console.error(USAGE)
    process.exit(1)
  }

  const trimmedTakeaways = takeaways?.trim()

  return {
    title,
    author: author.trim(),
    ...(trimmedTakeaways ? { takeaways: trimmedTakeaways } : {}),
  }
}

export async function book({ title, author, takeaways }: BookArgs) {
  const session = await loadSession()

  if (!session) {
    error('not logged in')
    info(`run ${dim('hacklab login')} first`)
    process.exit(1)
  }

  if (title.length > TITLE_MAX) {
    error(`title too long — ${title.length}/${TITLE_MAX} chars`)
    process.exit(1)
  }

  if (author.length > AUTHOR_MAX) {
    error(`author too long — ${author.length}/${AUTHOR_MAX} chars`)
    process.exit(1)
  }

  if (takeaways && takeaways.length > TAKEAWAYS_MAX) {
    error(`takeaways too long — ${takeaways.length}/${TAKEAWAYS_MAX} chars`)
    process.exit(1)
  }

  const res = await fetch(`${resolveAppUrl(session)}/api/books`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ title, author, takeaways }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => null)
    error(data?.error ?? `failed (${res.status})`)
    process.exit(1)
  }

  success('shelved.')
  if (!takeaways) {
    info(`no takeaways — the card shows without a details button`)
  }
}
