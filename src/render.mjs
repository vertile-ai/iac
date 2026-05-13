#!/usr/bin/env node

import process from 'node:process'
import { parseTargetOption, readOption } from './core/args.mjs'
import { resolvePlatformContext } from './core/context.mjs'
import { assertEnvironment, readManifest } from './core/manifest.mjs'
import { writeTargets } from './core/render.mjs'

async function main() {
  const argv = process.argv.slice(2)
  const context = resolvePlatformContext(argv)
  const manifest = readManifest(context.manifestPath)
  const environment = readOption(argv, '--env') || 'production'
  const targets = parseTargetOption(argv)

  assertEnvironment(manifest, environment)

  const rendered = await writeTargets({ context, manifest, environment, targets })
  for (const item of rendered) {
    console.log(`Rendered ${item.workspace}`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
