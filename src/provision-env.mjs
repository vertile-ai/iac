#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readVercelEnvManifest } from './core/vercel-manifests.mjs'
import { resolveIacContext } from './shared.mjs'

const iacContext = resolveIacContext(process.argv.slice(2), {
  autoCreateKeys: 'landing,web-client,web-server,auth,preview,payment',
  autoCreatePrefixes: 'template-',
})
const rootDir = iacContext.repoRoot
const tokenFilePath = iacContext.tokenFilePath
const apiBase = 'https://api.vercel.com'
const managedComment = 'managed by @vertile-ai/iac provision-env'
const legacyManagedComment = 'managed by infrastructure/IAC/provision-env.mjs'
const olderLegacyManagedComment = 'managed by scripts/vercel/provision-env.mjs'
const shouldAutoCreateProject = iacContext.shouldAutoCreateProject

function readPositiveIntegerEnv(key, fallback) {
  const value = Number(process.env[key])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

const defaultThrottleMs = readPositiveIntegerEnv('VERCEL_API_THROTTLE_MS', 250)
const maxRequestAttempts = Math.max(
  1,
  readPositiveIntegerEnv('VERCEL_API_MAX_ATTEMPTS', 4),
)

const validTargets = ['development', 'preview', 'production']
const validScopes = ['team', 'projects', 'all']

const c = {
  reset: '\x1b[0m',
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
}

function parseArgs(argv) {
  const args = {
    apply: false,
    scope: 'all',
    targets: ['preview', 'production'],
    projects: [],
    reconcileDelete: false,
  }

  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true
      continue
    }

    if (arg.startsWith('--scope=')) {
      args.scope = arg.slice('--scope='.length)
      continue
    }

    if (arg.startsWith('--targets=')) {
      args.targets = arg
        .slice('--targets='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      continue
    }

    if (arg.startsWith('--projects=')) {
      args.projects = arg
        .slice('--projects='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      continue
    }

    if (arg === '--reconcile-delete') {
      args.reconcileDelete = true
      continue
    }
  }

  if (!validScopes.includes(args.scope)) {
    throw new Error(
      `Invalid --scope value "${args.scope}". Use one of: ${validScopes.join(', ')}`,
    )
  }

  for (const target of args.targets) {
    if (!validTargets.includes(target)) {
      throw new Error(
        `Invalid target "${target}". Use one of: ${validTargets.join(', ')}`,
      )
    }
  }

  return args
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return []

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  const entries = []
  const seen = new Set()

  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue

    const key = line.slice(0, index).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = line.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (!seen.has(key)) {
      entries.push({ key, value })
      seen.add(key)
    } else {
      const i = entries.findIndex((entry) => entry.key === key)
      entries[i] = { key, value }
    }
  }

  return entries
}

function readTokenFromFile(filePath) {
  if (!fs.existsSync(filePath)) return ''

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (trimmed.startsWith('VERCEL_TOKEN=')) {
      return trimmed.slice('VERCEL_TOKEN='.length).trim()
    }
    if (trimmed.startsWith('VERCEL_API_KEY=')) {
      return trimmed.slice('VERCEL_API_KEY='.length).trim()
    }

    // Also allow plain token-only files.
    return trimmed
  }

  return ''
}

// Maps a Vercel target name to the .env filename used in infrastructure folders.
const targetToEnvFile = {
  development: '.env.development',
  staging: '.env.staging',
  production: '.env.production',
}

function readInfraScopedEntries(infraDir, target, projects) {
  const envFile = targetToEnvFile[target]

  const teamEntries = parseEnvFile(path.join(rootDir, infraDir, 'shared', envFile))

  const projectEntries = Object.fromEntries(
    projects.map((project) => [
      project.key,
      parseEnvFile(path.join(rootDir, infraDir, project.key, envFile)),
    ]),
  )

  return { teamEntries, projectEntries }
}

function targetIncludes(envVar, target) {
  const envTarget = envVar?.target
  if (!envTarget) return false
  if (Array.isArray(envTarget)) return envTarget.includes(target)
  return envTarget === target
}

function toQuery(params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }
  const encoded = query.toString()
  return encoded ? `?${encoded}` : ''
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function chunkEntries(entries, size) {
  const chunks = []
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(entries.slice(index, index + size))
  }
  return chunks
}

function readRetryAfterMs(response, attempt) {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const retryAfterSeconds = Number(retryAfter)
    if (Number.isFinite(retryAfterSeconds)) {
      return Math.max(0, retryAfterSeconds * 1000)
    }

    const retryAfterDate = Date.parse(retryAfter)
    if (Number.isFinite(retryAfterDate)) {
      return Math.max(0, retryAfterDate - Date.now())
    }
  }

  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - Date.now())
  }

  return Math.min(30000, 1000 * 2 ** attempt)
}

async function requestJSON({ token, method, pathname, query, body }) {
  const url = `${apiBase}${pathname}${toQuery(query || {})}`

  for (let attempt = 0; attempt < maxRequestAttempts; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (response.ok) {
      if (defaultThrottleMs > 0) await sleep(defaultThrottleMs)
      if (response.status === 204) return {}
      return response.json()
    }

    const errorText = await response.text()
    if (response.status === 429 && attempt < maxRequestAttempts - 1) {
      const delayMs = readRetryAfterMs(response, attempt)
      console.warn(
        `[rate-limit] Vercel API ${method} ${pathname} returned 429; retrying in ${Math.ceil(delayMs / 1000)}s`,
      )
      await sleep(delayMs)
      continue
    }

    throw new Error(
      `Vercel API ${method} ${pathname} failed (${response.status}): ${errorText}`,
    )
  }

  throw new Error(`Vercel API ${method} ${pathname} failed after retries`)
}

async function resolveTeamId({ token, teamSlug }) {
  const teams = await requestJSON({
    token,
    method: 'GET',
    pathname: '/v1/teams',
  })
  const rows = Array.isArray(teams.teams) ? teams.teams : []
  const match = rows.find((team) => team?.slug === teamSlug)
  if (!match?.id) {
    throw new Error(`Unable to resolve team ID for slug "${teamSlug}"`)
  }
  return match.id
}

async function listTeamProjects({ token, teamId }) {
  const projects = await requestJSON({
    token,
    method: 'GET',
    pathname: '/v9/projects',
    query: { teamId, limit: 100 },
  })
  return Array.isArray(projects.projects) ? projects.projects : []
}

async function createTeamProject({ token, teamId, name }) {
  const project = await requestJSON({
    token,
    method: 'POST',
    pathname: '/v10/projects',
    query: { teamId },
    body: { name },
  })

  const id =
    typeof project?.id === 'string'
      ? project.id.trim()
      : typeof project?.project?.id === 'string'
        ? project.project.id.trim()
        : ''

  if (!id) {
    throw new Error(`Created Vercel project "${name}" but no project id was returned`)
  }

  return id
}

function isOnlyExistingKeyAndTargetError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const jsonStart = message.indexOf('{')
  if (jsonStart < 0) return false

  try {
    const payload = JSON.parse(message.slice(jsonStart))
    const failed = Array.isArray(payload?.failed) ? payload.failed : []
    if (failed.length === 0) return false
    return failed.every(
      (item) => item?.error?.code === 'existing_key_and_target',
    )
  } catch {
    return false
  }
}

function isManagedEnvVar(envVar) {
  return (
    envVar?.comment === managedComment ||
    envVar?.comment === legacyManagedComment ||
    envVar?.comment === olderLegacyManagedComment
  )
}

async function listTeamEnvVars({ token, teamSlug }) {
  const rows = []
  let until

  while (true) {
    const response = await requestJSON({
      token,
      method: 'GET',
      pathname: '/v1/env',
      query: { slug: teamSlug, limit: 100, until },
    })

    const pageRows = Array.isArray(response.data) ? response.data : []
    rows.push(...pageRows)

    const next = response?.pagination?.next
    if (!next) break
    until = next
  }

  return rows
}

async function listProjectEnvVars({ token, teamSlug, projectId }) {
  const response = await requestJSON({
    token,
    method: 'GET',
    pathname: `/v10/projects/${encodeURIComponent(projectId)}/env`,
    query: { slug: teamSlug, decrypt: 'false' },
  })

  return Array.isArray(response.envs) ? response.envs : []
}

async function deleteTeamEnvVar({ token, teamSlug, envVarId }) {
  await requestJSON({
    token,
    method: 'DELETE',
    pathname: `/v1/env/${encodeURIComponent(envVarId)}`,
    query: { slug: teamSlug },
  })
}

async function deleteProjectEnvVar({ token, teamSlug, projectId, envVarId }) {
  await requestJSON({
    token,
    method: 'DELETE',
    pathname: `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envVarId)}`,
    query: { slug: teamSlug },
  })
}

async function upsertTeamShared({
  token,
  dryRun,
  reconcileDelete,
  teamSlug,
  target,
  entries,
  projectIds,
}) {
  if (entries.length === 0 && !reconcileDelete) {
    console.log(`${c.gray(`[team:${target}]`)} no keys, skipping`)
    return
  }

  if (!token) {
    if (reconcileDelete) {
      console.log(
        `${c.cyan(`[team:${target}]`)} ${c.yellow('dry-run (offline):')} cannot compute reconcile deletes without token`,
      )
    }
    console.log(
      `${c.cyan(`[team:${target}]`)} ${c.yellow('dry-run (offline):')} would upsert ${c.bold(String(entries.length))} shared keys`,
    )
    return
  }

  const allTeamEnvVars = await listTeamEnvVars({ token, teamSlug })
  const scopedTeamVars = allTeamEnvVars.filter((envVar) =>
    targetIncludes(envVar, target),
  )

  const existingByKey = new Map()
  for (const envVar of scopedTeamVars) {
    if (typeof envVar?.key === 'string' && typeof envVar?.id === 'string') {
      existingByKey.set(envVar.key, envVar)
    }
  }

  const updates = {}
  const updateKeys = []
  const creates = []
  const desiredKeys = new Set(entries.map((entry) => entry.key))

  for (const entry of entries) {
    const match = existingByKey.get(entry.key)

    if (match) {
      updates[match.id] = {
        value: entry.value,
        type: 'encrypted',
        target: [target],
        projectIdUpdates: { link: projectIds },
        comment: managedComment,
      }
      updateKeys.push(entry.key)
    } else {
      creates.push({
        key: entry.key,
        value: entry.value,
        comment: managedComment,
      })
    }
  }

  const staleManagedVars = reconcileDelete
    ? scopedTeamVars.filter(
        (envVar) => !desiredKeys.has(envVar.key) && isManagedEnvVar(envVar),
      )
    : []

  const updateCount = updateKeys.length
  console.log(
    `${c.cyan(`[team:${target}]`)} ${dryRun ? 'would update' : c.green('updating')} ${c.bold(String(updateCount))}, ${dryRun ? 'would create' : c.green('creating')} ${c.bold(String(creates.length))}`,
  )
  if (reconcileDelete) {
    console.log(
      `${c.cyan(`[team:${target}]`)} ${dryRun ? 'would delete' : c.green('deleting')} ${c.bold(String(staleManagedVars.length))} stale managed keys`,
    )
  }
  if (dryRun) {
    if (updateKeys.length > 0) {
      console.log(`  ${c.yellow('update:')} ${c.dim(updateKeys.join(', '))}`)
    }
    if (creates.length > 0) {
      console.log(`  ${c.blue('create:')} ${c.dim(creates.map((e) => e.key).join(', '))}`)
    }
    if (staleManagedVars.length > 0) {
      console.log(
        `  ${c.red('delete:')} ${c.dim(staleManagedVars.map((envVar) => envVar.key).join(', '))}`,
      )
    }
    return
  }

  if (updateCount > 0) {
    for (const updateChunk of chunkEntries(Object.entries(updates), 50)) {
      await requestJSON({
        token,
        method: 'PATCH',
        pathname: '/v1/env',
        query: { slug: teamSlug },
        body: { updates: Object.fromEntries(updateChunk) },
      })
    }
  }

  if (creates.length > 0) {
    try {
      await requestJSON({
        token,
        method: 'POST',
        pathname: '/v1/env',
        query: { slug: teamSlug },
        body: {
          evs: creates,
          type: 'encrypted',
          target: [target],
          projectId: projectIds,
        },
      })
    } catch (error) {
      if (isOnlyExistingKeyAndTargetError(error)) {
        console.log(
          c.yellow(
            `[team:${target}] create request contained only existing keys; continuing`,
          ),
        )
      } else {
        throw error
      }
    }
  }

  for (const envVar of staleManagedVars) {
    await deleteTeamEnvVar({
      token,
      teamSlug,
      envVarId: envVar.id,
    })
  }
}

async function upsertProjectEnv({
  token,
  dryRun,
  reconcileDelete,
  teamSlug,
  projectId,
  projectName,
  target,
  entries,
}) {
  if (entries.length === 0 && !reconcileDelete) {
    console.log(`${c.gray(`[project:${projectName}:${target}]`)} no keys, skipping`)
    return
  }

  console.log(
    `${c.cyan(`[project:${projectName}:${target}]`)} ${dryRun ? 'would upsert' : c.green('upserting')} ${c.bold(String(entries.length))} keys`,
  )

  if (dryRun) {
    console.log(`  ${c.blue('upsert:')} ${c.dim(entries.map((e) => e.key).join(', '))}`)
  } else if (!token) {
    throw new Error('Missing Vercel token for apply mode')
  }

  if (entries.length > 0 && !dryRun) {
    const payload = entries.map((entry) => ({
      key: entry.key,
      value: entry.value,
      type: 'encrypted',
      target: [target],
      comment: managedComment,
    }))

    await requestJSON({
      token,
      method: 'POST',
      pathname: `/v10/projects/${encodeURIComponent(projectId)}/env`,
      query: { slug: teamSlug, upsert: 'true' },
      body: payload,
    })
  }

  if (!reconcileDelete) return

  if (!token) {
    console.log(
      `${c.cyan(`[project:${projectName}:${target}]`)} ${c.yellow('dry-run (offline):')} cannot compute reconcile deletes without token`,
    )
    return
  }

  const desiredKeys = new Set(entries.map((entry) => entry.key))
  const existingVars = await listProjectEnvVars({ token, teamSlug, projectId })
  const staleManagedVars = existingVars.filter(
    (envVar) => targetIncludes(envVar, target) && !desiredKeys.has(envVar.key) && isManagedEnvVar(envVar),
  )

  console.log(
    `${c.cyan(`[project:${projectName}:${target}]`)} ${dryRun ? 'would delete' : c.green('deleting')} ${c.bold(String(staleManagedVars.length))} stale managed keys`,
  )

  if (dryRun) {
    if (staleManagedVars.length > 0) {
      console.log(
        `  ${c.red('delete:')} ${c.dim(staleManagedVars.map((envVar) => envVar.key).join(', '))}`,
      )
    }
    return
  }

  for (const envVar of staleManagedVars) {
    await deleteProjectEnvVar({
      token,
      teamSlug,
      projectId,
      envVarId: envVar.id,
    })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dryRun = !args.apply
  const token =
    process.env.VERCEL_TOKEN ||
    process.env.VERCEL_API_KEY ||
    readTokenFromFile(tokenFilePath)
  const manifest = readVercelEnvManifest(iacContext)
  const teamSlug = manifest.teamSlug
  const projects = Array.isArray(manifest.projects) ? manifest.projects : []
  const configuredProjects = [...projects]
  const infraDir = iacContext.infraDir || manifest.infraDir

  if (!teamSlug) {
    throw new Error('Missing "teamSlug" in env manifest')
  }
  if (!infraDir) {
    throw new Error('Missing "infraDir" in env manifest')
  }

  let teamId = ''
  if (token) {
    teamId = await resolveTeamId({ token, teamSlug })
    const remoteProjects = await listTeamProjects({ token, teamId })
    const remoteIdByName = new Map(
      remoteProjects
        .filter(
          (project) =>
            typeof project.name === 'string' &&
            project.name.trim().length > 0 &&
            typeof project.id === 'string' &&
            project.id.trim().length > 0
        )
        .map((project) => [project.name.trim(), project.id.trim()])
    )

    for (const project of configuredProjects) {
      if (
        typeof project?.key !== 'string' ||
        typeof project?.name !== 'string' ||
        (typeof project?.id === 'string' && project.id.trim().length > 0)
      ) {
        continue
      }

      const projectName = project.name.trim()
      let resolvedId = remoteIdByName.get(projectName)

      if (!resolvedId && shouldAutoCreateProject(project.key)) {
        if (dryRun) {
          console.log(
            c.yellow(
              `[plan] ${project.key}: would create Vercel project "${projectName}" because env-manifest id is missing`,
            ),
          )
          continue
        }

        resolvedId = await createTeamProject({
          token,
          teamId,
          name: projectName,
        })
        remoteIdByName.set(projectName, resolvedId)
        console.log(
          c.green(
            `[created] ${project.key}: created Vercel project "${projectName}" -> ${resolvedId}`,
          ),
        )
      }

      if (!resolvedId) continue
      project.id = resolvedId
      console.log(
        c.gray(
          `[resolved] ${project.key}: using Vercel project "${project.name}" -> ${resolvedId}`
        )
      )
    }
  }

  const configuredProjectsWithId = configuredProjects.filter(
    (project) => typeof project.id === 'string' && project.id.trim().length > 0
  )
  const projectIds = configuredProjectsWithId.map((project) => project.id)

  const selectedProjects = args.projects.length
    ? projects.filter((project) => args.projects.includes(project.key))
    : projects

  if (args.projects.length && selectedProjects.length !== args.projects.length) {
    const found = new Set(selectedProjects.map((project) => project.key))
    const missing = args.projects.filter((project) => !found.has(project))
    throw new Error(`Unknown project key(s): ${missing.join(', ')}`)
  }

  const selectedConfiguredProjects = selectedProjects.filter((project) =>
    configuredProjectsWithId.some((configured) => configured.key === project.key),
  )
  const selectedConfiguredProjectIds = selectedConfiguredProjects.map((project) => {
    const configured = configuredProjectsWithId.find(
      (candidate) => candidate.key === project.key,
    )
    return configured.id
  })
  const skippedUnconfiguredProjects = selectedProjects.filter(
    (project) =>
      !configuredProjectsWithId.some((configured) => configured.key === project.key),
  )

  if (skippedUnconfiguredProjects.length > 0) {
    console.log(
      c.yellow(
        `Skipping project(s) without Vercel project ID: ${skippedUnconfiguredProjects.map((project) => project.key).join(', ')}`,
      ),
    )
  }

  if (!dryRun && !token) {
    throw new Error('Missing VERCEL_TOKEN (or VERCEL_API_KEY) for apply mode')
  }

  console.log(
    `${c.bold('Mode:')} ${dryRun ? c.yellow('dry-run') : c.green('apply')} ${c.gray('|')} scope=${c.cyan(args.scope)} ${c.gray('|')} targets=${c.cyan(args.targets.join(','))} ${c.gray('|')} reconcile-delete=${c.cyan(args.reconcileDelete ? 'on' : 'off')}`,
  )

  // preview deployments read from the staging env files
  const resolvedTarget = (target) => (target === 'preview' ? 'staging' : target)

  if (args.scope === 'team' || args.scope === 'all') {
    for (const target of args.targets) {
      const parsed = readInfraScopedEntries(infraDir, resolvedTarget(target), projects)
      await upsertTeamShared({
        token,
        dryRun,
        reconcileDelete: args.reconcileDelete,
        teamSlug,
        target,
        entries: parsed.teamEntries,
        projectIds: args.projects.length ? selectedConfiguredProjectIds : projectIds,
      })
    }
  }

  if (args.scope === 'projects' || args.scope === 'all') {
    const parsedByTarget = {}
    for (const target of args.targets) {
      parsedByTarget[target] = readInfraScopedEntries(
        infraDir,
        resolvedTarget(target),
        selectedProjects,
      )
    }

    for (const project of selectedConfiguredProjects) {
      for (const target of args.targets) {
        const entries = parsedByTarget[target].projectEntries[project.key] || []
        await upsertProjectEnv({
          token,
          dryRun,
          reconcileDelete: args.reconcileDelete,
          teamSlug,
          projectId: project.id,
          projectName: project.name,
          target,
          entries,
        })
      }
    }
  }
}

main().catch((error) => {
  console.error(c.red('Error:'), error instanceof Error ? error.message : String(error))
  process.exit(1)
})
