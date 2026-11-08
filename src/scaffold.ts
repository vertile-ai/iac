#!/usr/bin/env node
// @ts-nocheck

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readOption } from './core/args.js'
import { scaffoldRepository } from './init.js'

async function main() {
  const argv = process.argv.slice(2)
  const repoRoot = path.resolve(readOption(argv, '--repo-root') || process.cwd())
  const manifestPath = path.join(repoRoot, 'iac.json')
  const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await scaffoldRepository(repoRoot, rawManifest)
  process.stdout.write(`Scaffolded Vertile IaC for ${rawManifest.repository}.\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
