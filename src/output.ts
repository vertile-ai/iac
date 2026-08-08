#!/usr/bin/env node

import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseSingleTargetOption, parseTerraformInitOptions, readOption } from './core/args.js'
import { resolvePlatformContext } from './core/context.js'
import { readManifest } from './core/manifest.js'
import { writeTarget } from './core/render.js'
import { terraformOutputJson } from './core/terraform.js'

function compareCodeUnits(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function parseTerraformOutput(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('terraform output -json returned malformed JSON.')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('terraform output -json must return a JSON object.')
  }

  const sensitive = Object.entries(parsed)
    .filter(([, output]: any) => output?.sensitive === true)
    .map(([name]) => name)

  if (sensitive.length > 0) {
    throw new Error(`Refusing to print sensitive Terraform outputs: ${sensitive.join(', ')}`)
  }

  return Object.fromEntries(
    Object.entries(parsed)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([name, output]: any) => {
        if (!output || typeof output !== 'object' || !('value' in output)) {
          throw new Error(`terraform output -json entry "${name}" is missing a value.`)
        }
        return [name, output.value]
      }),
  )
}

async function main() {
  const argv = process.argv.slice(2)
  const context = resolvePlatformContext(argv)
  const manifest = readManifest(context.manifestPath)
  const environment = readOption(argv, '--env') || 'production'
  const deploymentName = readOption(argv, '--deployment') || ''
  const target = parseSingleTargetOption(argv)
  const init = parseTerraformInitOptions(argv)

  const rendered = await writeTarget({ context, manifest, environment, target, deploymentName })
  const rawOutput = terraformOutputJson({
    terraformBin: context.terraformBin,
    workspace: rendered.workspace,
    init,
  })
  const output = {
    target,
    deployment: rendered.deployment.name,
    environment: rendered.deployment.environment,
    outputs: parseTerraformOutput(rawOutput),
  }

  console.log(JSON.stringify(output, null, 2))
}

export const testing = {
  parseTerraformOutput,
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
