#!/usr/bin/env node

import process from 'node:process'
import { parseTargetOption, readOption } from './core/args.js'
import { resolvePlatformContext } from './core/context.js'
import { readManifest } from './core/manifest.js'
import { writeTargets } from './core/render.js'
import { terraformPlan } from './core/terraform.js'

async function main() {
  const argv = process.argv.slice(2)
  const context = resolvePlatformContext(argv)
  const manifest = readManifest(context.manifestPath)
  const environment = readOption(argv, '--env') || 'production'
  const deploymentName = readOption(argv, '--deployment') || ''
  const targets = parseTargetOption(argv)

  const rendered = await writeTargets({ context, manifest, environment, targets, deploymentName })
  for (const item of rendered) {
    console.log(`Planning ${item.workspace}`)
    terraformPlan({
      terraformBin: context.terraformBin,
      workspace: item.workspace,
    })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
