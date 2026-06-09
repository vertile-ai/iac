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
  ['render', path.join(root, 'render.mjs')],
  ['plan', path.join(root, 'plan.mjs')],
  ['apply', path.join(root, 'apply.mjs')],
  ['sync-env', path.join(root, 'sync-env.mjs')],
  ['env', path.join(root, 'provision-env.mjs')],
  ['projects', path.join(root, 'reconcile-project-settings.mjs')],
  ['domains', path.join(root, 'reconcile-project-domains.mjs')],
])

function printHelp() {
  console.log(`vertile-iac

Usage:
  vertile-iac render --target=vercel|aws|digitalocean|all --env=<name> [options]
  vertile-iac plan --target=vercel|aws|digitalocean|all --env=<name> [options]
  vertile-iac apply --target=vercel|aws|digitalocean|all --env=<name> [options]
  vertile-iac sync-env [options]
  vertile-iac env [options]
  vertile-iac projects [options]
  vertile-iac domains [options]

Commands:
  render     Render Terraform workspaces from infrastructure/iac/iac.json.
  plan       Render Terraform workspaces and run terraform plan.
  apply      Render Terraform workspaces and run terraform apply.
  sync-env   Generate package .env files from the configured env source tree.
  env        Compatibility: reconcile Vercel team and project environment variables.
  projects   Compatibility: reconcile Vercel project settings.
  domains    Compatibility: reconcile Vercel project domains.

${sharedOptionsHelp()}
  --out <path>                Generated Terraform root. Defaults to .vertile/terraform.
  --target <name|all>         Target provider: vercel, aws, digitalocean, or all.
  --env <name>                Environment to render, plan, or apply. Defaults to production.
  --deployment <name>         Provider deployment/stage name, such as uat or prod.
  --terraform-bin <path>      Terraform executable. Defaults to terraform.
  --yes                       Allow non-interactive apply with Terraform auto-approve.
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
