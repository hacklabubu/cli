import { COMMAND_NAMES } from './registry.js'

export type ResolvedCommand =
  | { kind: 'match'; name: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'unknown' }

/**
 * Resolve a (possibly abbreviated) command token to a full command name by
 * shortest unambiguous prefix:
 * - an exact match always wins, so a full command is never shadowed by a longer
 *   one (e.g. if `scan` and `scanner` both existed, `scan` resolves to `scan`);
 * - a prefix that matches exactly one command resolves to it (`sy` -> sync);
 * - a prefix matching several is ambiguous (`s` -> sync | scan);
 * - a token matching none is unknown (a typo like `ogr` does not resolve).
 */
export function resolveCommand(
  token: string,
  commands: readonly string[] = COMMAND_NAMES
): ResolvedCommand {
  const exact = commands.find(
    (command) => command.toLowerCase() === token.toLowerCase()
  )
  if (exact) return { kind: 'match', name: exact }

  const matches = commands.filter((c) => c.startsWith(token))
  if (matches.length === 1) return { kind: 'match', name: matches[0]! }
  if (matches.length > 1) return { kind: 'ambiguous', matches }
  return { kind: 'unknown' }
}
