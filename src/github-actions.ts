#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { envSourceDir } from './core/env-source.js'
import { buildGitHubActionsPlan, githubTokenFromManifest } from './core/github-actions.js'
import { readManifest } from './core/manifest.js'
import { resolveIacContext, readOption } from './shared.js'

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    repo: readOption(argv, '--repo'),
    environments: splitList(readOption(argv, '--env') || readOption(argv, '--environments')),
  }
}

function resolveRepoFromGit(repoRoot) {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  if (result.status !== 0) return ''

  const remote = result.stdout.trim()
  const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/)
  if (sshMatch?.[1]) return sshMatch[1]

  const httpsMatch = remote.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/)
  if (httpsMatch?.[1]) return httpsMatch[1]

  return ''
}

function runGh(args, options: any = {}) {
  const env = options.token
    ? { ...process.env, GH_TOKEN: options.token }
    : process.env
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env,
    input: options.input,
    stdio: options.input ? ['pipe', 'pipe', 'pipe'] : 'pipe',
  })

  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(' ')} failed: ${result.stderr?.trim() || result.stdout?.trim() || 'unknown error'}`,
    )
  }

  return result.stdout
}

function environmentPathName(environmentName) {
  return encodeURIComponent(environmentName)
}

function ensureGhCliAvailable(token) {
  runGh(['--version'], { token })
  if (!token && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    runGh(['auth', 'status'])
  }
}

function printPlan({ plan, apply }) {
  console.log(`${apply ? '[apply]' : '[dry-run]'} GitHub Actions env sync target: ${plan.repo}`)

  for (const environment of plan.environments) {
    console.log('')
    console.log(`Environment: ${environment.name} (source: ${environment.environment})`)
    if (environment.branches.length > 0) {
      console.log(`Branches: ${environment.branches.join(', ')}`)
    }

    const secrets = environment.outputs.filter((entry) => entry.secret)
    const variables = environment.outputs.filter((entry) => !entry.secret)

    console.log('Secrets:')
    for (const entry of secrets) {
      console.log(`- ${entry.key} <= ${entry.source} (${entry.value.length} chars)`)
    }

    console.log('Variables:')
    for (const entry of variables) {
      console.log(`- ${entry.key} <= ${entry.source} (${entry.value})`)
    }
  }
}

function ensureEnvironment({ repo, environment, token }) {
  const environmentName = environmentPathName(environment.name)
  const body = environment.branches.length > 0
    ? {
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      }
    : {}

  runGh(
    ['api', '--method', 'PUT', `repos/${repo}/environments/${environmentName}`, '--input', '-'],
    { input: `${JSON.stringify(body)}\n`, token },
  )
}

function existingBranchPolicies({ repo, environmentName, token }) {
  const encodedEnvironmentName = environmentPathName(environmentName)
  const output = runGh([
    'api',
    `repos/${repo}/environments/${encodedEnvironmentName}/deployment-branch-policies`,
  ], { token })
  const parsed = JSON.parse(output)
  return new Set((parsed.branch_policies || []).map((policy) => policy.name))
}

function ensureBranchPolicies({ repo, environment, token }) {
  if (environment.branches.length === 0) return

  const existing = existingBranchPolicies({ repo, environmentName: environment.name, token })
  for (const branch of environment.branches) {
    if (existing.has(branch)) continue

    const environmentName = environmentPathName(environment.name)
    runGh([
      'api',
      '--method',
      'POST',
      `repos/${repo}/environments/${environmentName}/deployment-branch-policies`,
      '-f',
      `name=${branch}`,
      '-f',
      'type=branch',
    ], { token })
  }
}

function setEnvironmentOutput({ repo, environmentName, entry, token }) {
  const args = [
    entry.secret ? 'secret' : 'variable',
    'set',
    entry.key,
    '--repo',
    repo,
    '--env',
    environmentName,
    '--body',
    entry.value,
  ]
  runGh(args, { token })
}

function applyPlan(plan, options: any = {}) {
  const token = options.token || ''
  ensureGhCliAvailable(token)

  for (const environment of plan.environments) {
    ensureEnvironment({ repo: plan.repo, environment, token })
    ensureBranchPolicies({ repo: plan.repo, environment, token })

    for (const entry of environment.outputs) {
      if (!entry.value) {
        throw new Error(`Cannot set empty GitHub Actions value for ${environment.name}.${entry.key}.`)
      }
      setEnvironmentOutput({ repo: plan.repo, environmentName: environment.name, entry, token })
      console.log(`[applied] ${environment.name}.${entry.key}`)
    }
  }
}

function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const context = resolveIacContext(argv)
  const manifest = readManifest(context.iacManifestPath)
  const sourceRoot = path.join(context.repoRoot, envSourceDir(manifest))
  const plan = buildGitHubActionsPlan({
    manifest,
    sourceRoot,
    selectedEnvironments: args.environments,
  })
  plan.repo = args.repo || plan.repo || resolveRepoFromGit(context.repoRoot)
  if (!plan.repo) {
    throw new Error('GitHub repository must be configured with providers.github.repository or --repo.')
  }

  printPlan({ plan, apply: args.apply })
  if (args.apply) applyPlan(plan, { token: githubTokenFromManifest(manifest) })
}

export const testing = {
  splitList,
  parseArgs,
  environmentPathName,
  printPlan,
  applyPlan,
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
