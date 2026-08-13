#!/usr/bin/env node
// @ts-nocheck

import { access, chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readOption } from './core/args.js'
import { normalizeManifest } from './core/manifest.js'
import { inferRepositoryIdentity } from './core/repository-context.js'

async function writeExclusiveJson(filePath, value, mode) {
  const file = await open(filePath, 'wx', mode)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
  } finally {
    await file.close()
  }
  if (process.platform !== 'win32') await chmod(filePath, mode)
}

async function ensurePrivateIgnore(repoRoot) {
  const ignorePath = path.join(repoRoot, '.gitignore')
  let source = ''
  try {
    source = await readFile(ignorePath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (source.split(/\r?\n/).includes('/.iac/private.json')) return
  const separator = source && !source.endsWith('\n') ? '\n' : ''
  await writeFile(ignorePath, `${source}${separator}/.iac/private.json\n`)
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function privateScaffold(rawManifest, manifest) {
  const env = {}
  for (const [sourceKey, metadata] of Object.entries(manifest.env?.metadata || {})) {
    const variables = Array.isArray(metadata?.variables) ? metadata.variables : []
    const encrypted = variables.filter(
      (variable) => variable?.encrypted === true && typeof variable.key === 'string',
    )
    if (encrypted.length === 0) continue
    env[sourceKey] = Object.fromEntries(encrypted.map((variable) => [
      variable.key,
      Object.fromEntries(manifest.environments.map((environment) => [environment, ''])),
    ]))
  }

  const credentials = Object.fromEntries(
    Object.entries(rawManifest.credentials || {}).map(([id, declaration]) => [
      id,
      Object.fromEntries((declaration?.environments || []).map((environment) => [environment, ''])),
    ]),
  )
  return { version: 1, env, credentials }
}

function mergeMissingScaffold(existing, desired) {
  const merged = structuredClone(existing)
  merged.env ||= {}
  merged.credentials ||= {}
  for (const [source, variables] of Object.entries(desired.env)) {
    merged.env[source] ||= {}
    for (const [key, environments] of Object.entries(variables)) {
      merged.env[source][key] ||= {}
      for (const environment of Object.keys(environments)) {
        if (!Object.hasOwn(merged.env[source][key], environment)) {
          merged.env[source][key][environment] = ''
        }
      }
    }
  }
  for (const [id, environments] of Object.entries(desired.credentials)) {
    merged.credentials[id] ||= {}
    for (const environment of Object.keys(environments)) {
      if (!Object.hasOwn(merged.credentials[id], environment)) {
        merged.credentials[id][environment] = ''
      }
    }
  }
  return merged
}

async function writePrivateJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, filePath)
  if (process.platform !== 'win32') await chmod(filePath, 0o600)
}

function safeSegment(value, label) {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
    || value === '.'
    || value === '..'
  ) {
    throw new Error(`${label} must be a safe path segment.`)
  }
  return value
}

async function ensureRepositoryRoot(repoRoot, rawManifest) {
  const [ownerValue, repoValue, extra] = rawManifest.repository.split('/')
  if (extra !== undefined) throw new Error('iac.json repository must use owner/repo format.')
  const owner = safeSegment(ownerValue, 'iac.json repository owner')
  const repo = safeSegment(repoValue, 'iac.json repository name')
  const repositoryRoot = path.join(
    os.homedir(),
    '.iac',
    'repositories',
    'github',
    owner,
    repo,
  )
  await mkdir(repositoryRoot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(repositoryRoot, 0o700)

  for (const [stackValue, stack] of Object.entries(rawManifest.terraform?.stacks || {})) {
    const stackName = safeSegment(stackValue, 'Terraform stack name')
    for (const environmentValue of Object.keys(stack?.environments || {})) {
      const environment = safeSegment(environmentValue, 'Terraform environment name')
      const environmentRoot = path.join(
        repositoryRoot,
        'terraform',
        stackName,
        environment,
      )
      await mkdir(environmentRoot, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') await chmod(environmentRoot, 0o700)
    }
  }
}

export async function scaffoldRepository(repoRoot, rawManifest) {
  if (rawManifest.version !== 2) {
    throw new Error('Existing iac.json must use version 2 before scaffolding.')
  }
  const manifest = normalizeManifest(rawManifest)
  await ensurePrivateIgnore(repoRoot)
  const privateDirectory = path.join(repoRoot, '.iac')
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 })
  const privatePath = path.join(privateDirectory, 'private.json')
  if (await exists(privatePath)) {
    const existing = JSON.parse(await readFile(privatePath, 'utf8'))
    await writePrivateJson(
      privatePath,
      mergeMissingScaffold(existing, privateScaffold(rawManifest, manifest)),
    )
  } else {
    await writeExclusiveJson(privatePath, privateScaffold(rawManifest, manifest), 0o600)
  }
  await ensureRepositoryRoot(repoRoot, rawManifest)
}

async function main() {
  const argv = process.argv.slice(2)
  const repoRoot = path.resolve(readOption(argv, '--repo-root') || process.cwd())
  const manifestPath = path.join(repoRoot, 'iac.json')
  if (await exists(manifestPath)) {
    throw new Error('iac.json already exists. Use vertile-iac scaffold instead.')
  }
  const identity: any = inferRepositoryIdentity(repoRoot)
  const repository = identity.kind === 'github'
    ? `${identity.owner}/${identity.repo}`
    : `${identity.user}/${identity.repo}`
  const rawManifest = {
    version: 2,
    repository,
    environments: ['local', 'staging', 'production'],
    providers: {},
    apps: [],
  }
  await writeExclusiveJson(manifestPath, rawManifest, 0o644)
  await scaffoldRepository(repoRoot, rawManifest)
  process.stdout.write(`Initialized Vertile IaC for ${repository}.\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
