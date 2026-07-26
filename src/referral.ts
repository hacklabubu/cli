// The referral link and its share copy live here, in one place, so every
// surface that shows it (the `join` onboarding outro, the standalone `hacklab
// referral` command) builds the exact same URL and message. A referral is just
// the user's handle carried on a `?ref=` query param onto the marketing site:
// the root domain always resolves, an unrecognized query param can't 404, and
// it's the conventional shape for the backend to attribute a signup to whoever
// sent the link.

/**
 * A shareable referral URL for `handle`, hung off the site root so it lands on
 * the install/join page. `base` is a backend origin without a trailing slash
 * (what `resolveAppUrl` returns), e.g. `https://hacklab.so`.
 */
export function referralUrl(handle: string, base: string): string {
  const origin = base.replace(/\/$/, '')
  return `${origin}/?ref=${encodeURIComponent(handle)}`
}

/**
 * A ready-to-send, one-paragraph blurb a user can drop straight into a DM (or
 * an AI assistant that's helping them recruit) — the "message to send it to
 * your cool smart hacker friends." Ends with the referral link so the whole
 * thing is a single copy-paste.
 */
export function referralMessage(handle: string, base: string): string {
  return (
    'join me on hacklab — the terminal-native network for AI-native hackers. ' +
    'scan your AI token usage, see where you rank, and claim your profile:\n' +
    referralUrl(handle, base)
  )
}
