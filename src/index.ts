#!/usr/bin/env node

// Minimal launcher. It checks the Node version using ONLY built-ins, then
// dynamically imports the real CLI — so nothing that needs a Node 20+ API is
// even *linked* until the guard passes. The real entry (cli.ts) pulls in
// @clack/core, which statically imports `styleText` from node:util (Node 20.12+);
// on Node 18 that fails to link with a cryptic SyntaxError *before* any code
// runs, so the version check has to happen here, ahead of that import graph.
//
// npm only warns (doesn't block) on an `engines` mismatch, and version-manager
// users can switch to an old Node after installing — so this runtime guard is
// the real gate, not package.json.

const major = Number(process.versions.node.split('.')[0])
if (Number.isFinite(major) && major < 20) {
  console.error(
    `hacklab requires Node 20 or newer (you have ${process.versions.node}).`
  )
  console.error(
    'Using a version manager (nvm/fnm/volta)? Activate Node 20+ in your shell, then: npm install -g hacklab@latest'
  )
  process.exit(1)
}

// Defer the real CLI (and its Node 20+ import graph) until after the guard.
import('./cli.js').catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
