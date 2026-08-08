#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { sharedOptionsHelp } from './shared.js'

const command = process.argv[2]
const args = process.argv.slice(3)
const root = path.dirname(fileURLToPath(import.meta.url))

const commands = new Map([
  ['render', path.join(root, 'render.js')],
  ['plan', path.join(root, 'plan.js')],
  ['apply', path.join(root, 'apply.js')],
  ['output', path.join(root, 'output.js')],
  ['validate', path.join(root, 'validate.js')],
  ['sync-env', path.join(root, 'sync-env.js')],
  ['env', path.join(root, 'provision-env.js')],
  ['github-actions', path.join(root, 'github-actions.js')],
  ['projects', path.join(root, 'reconcile-project-settings.js')],
  ['domains', path.join(root, 'reconcile-project-domains.js')],
])

function printHelp() {
  console.log(`vertile-iac

Usage:
  vertile-iac render --target=vercel|aws|digitalocean|all --env=<name> [options]
  vertile-iac plan --target=vercel|aws|digitalocean|all --env=<name> [options]
  vertile-iac apply --target=vercel|aws|digitalocean|all --env=<name> [options]
  vertile-iac output --target=vercel|aws|digitalocean --env=<name> [options]
  vertile-iac validate [options]
  vertile-iac sync-env [options]
  vertile-iac env [options]
  vertile-iac github-actions [options]
  vertile-iac projects [options]
  vertile-iac domains [options]

Commands:
  render     Render Terraform workspaces from iac.json.
  plan       Render Terraform workspaces and run terraform plan.
  apply      Render Terraform workspaces and run terraform apply.
  output     Render one Terraform workspace and print non-sensitive outputs as JSON.
  validate   Validate manifest-driven environment routing without writing or calling providers.
  sync-env   Generate package .env files from the configured env source tree.
  env        Compatibility: reconcile Vercel team and project environment variables.
  github-actions
             Reconcile GitHub Actions environment secrets and variables.
  projects   Compatibility: reconcile Vercel project settings.
  domains    Compatibility: reconcile Vercel project domains.

${sharedOptionsHelp()}
  --out <path>                Generated Terraform root. Defaults to .vertile/terraform.
  --target <name|all>         Target provider: vercel, aws, digitalocean, or all.
  --env <name>                Environment to render, plan, or apply. Defaults to production.
  --deployment <name>         Provider deployment/stage name, such as uat or prod.
  --terraform-bin <path>      Terraform executable. Defaults to terraform.
  --yes                       Allow non-interactive apply with Terraform auto-approve.
  --migrate-state             Run terraform init with -migrate-state -force-copy.
  --reconfigure               Run terraform init with -reconfigure.
  --json                      Accepted by output; output is always JSON.
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
