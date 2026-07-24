import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The bin entry (index.ts) must stay a thin launcher: check the Node version
// with built-ins, THEN dynamically import the real CLI. A static import here
// would be linked before the guard runs, re-introducing the cryptic
// `styleText` SyntaxError on Node 18 (@clack/core imports a Node 20.12+ API).
const here = dirname(fileURLToPath(import.meta.url))
const launcher = readFileSync(join(here, 'index.ts'), 'utf8')

describe('bin launcher (index.ts)', () => {
  it('has no static imports — only a dynamic import(./cli.js)', () => {
    // `import ... from` / `import '...'` (whitespace after `import`) is static.
    // `import('./cli.js')` (paren right after) is dynamic and allowed.
    const hasStaticImport = /^\s*import\s+(?!\()/m.test(launcher)
    expect(hasStaticImport).toBe(false)
    expect(launcher).toContain("import('./cli.js')")
  })

  it('runs the Node < 20 guard before importing the CLI', () => {
    const guardIdx = launcher.indexOf('process.versions.node')
    const importIdx = launcher.indexOf("import('./cli.js')")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(importIdx).toBeGreaterThan(guardIdx)
    expect(launcher).toContain('major < 20')
  })
})
