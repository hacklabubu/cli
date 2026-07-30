import { COMMAND_ALIASES, COMMAND_NAMES } from './registry.js'

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
 *
 * Aliases (`daemon` -> `demon`) resolve the same way and to the canonical name,
 * but they collapse into that name for ambiguity purposes: a prefix shared by a
 * command and its own alias is not ambiguous, it just resolves.
 */
export function resolveCommand(
  token: string,
  commands: readonly string[] = COMMAND_NAMES,
  aliases: Record<string, string> = COMMAND_ALIASES
): ResolvedCommand {
  if (commands.includes(token)) return { kind: 'match', name: token }
  const exactAlias = aliases[token]
  if (exactAlias) return { kind: 'match', name: exactAlias }

  // Dedupe by canonical name and keep registry order, so `dae` (alias-only) and
  // `de` (command) both land on `demon` without reporting it twice.
  const matches = [
    ...new Set([
      ...commands.filter((c) => c.startsWith(token)),
      ...Object.entries(aliases)
        .filter(([alias]) => alias.startsWith(token))
        .map(([, name]) => name),
    ]),
  ]
  if (matches.length === 1) return { kind: 'match', name: matches[0]! }
  if (matches.length > 1) return { kind: 'ambiguous', matches }
  return { kind: 'unknown' }
}
