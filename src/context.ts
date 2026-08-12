#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readOption } from './core/args.js'
import { resolveRepositoryContext } from './core/repository-context.js'
import { findProjectRoot } from './shared.js'

function requiredOption(argv, name) {
  const value = readOption(argv, name)
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function safePathSegment(argv, name) {
  const value = requiredOption(argv, name)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${name} must be a safe single path segment using letters, digits, "_", or "-".`)
  }
  return value
}

async function main() {
  const argv = process.argv.slice(2)
  const repoRootArg = readOption(argv, '--repo-root')
  const repoRoot = repoRootArg ? path.resolve(repoRootArg) : findProjectRoot(process.cwd())
  const context = resolveRepositoryContext({
    repoRoot,
    stack: safePathSegment(argv, '--stack'),
    environment: safePathSegment(argv, '--environment'),
  })
  console.log(JSON.stringify(context, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
