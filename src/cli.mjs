#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { sharedOptionsHelp } from './shared.mjs'

const command = process.argv[2]
const args = process.argv.slice(3)
const root = path.dirname(fileURLToPath(import.meta.url))

const commands = new Map([
  ['env', path.join(root, 'provision-env.mjs')],
  ['projects', path.join(root, 'reconcile-project-settings.mjs')],
  ['domains', path.join(root, 'reconcile-project-domains.mjs')],
])

function printHelp() {
  console.log(`jazelly-iac

Usage:
  jazelly-iac env [options]
  jazelly-iac projects [options]
  jazelly-iac domains [options]

Commands:
  env        Reconcile Vercel team and project environment variables.
  projects   Reconcile Vercel project settings.
  domains    Reconcile Vercel project domains.

${sharedOptionsHelp()}
`)
}

if (!command || command === '--help' || command === '-h') {
  printHelp()
  process.exit(0)
}

const script = commands.get(command)
if (!script) {
  console.error(`Unknown command: ${command}`)
  printHelp()
  process.exit(1)
}

const result = spawnSync(process.execPath, [script, ...args], {
  stdio: 'inherit',
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 0)
