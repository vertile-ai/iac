#!/usr/bin/env node

import fs from 'node:fs'
import process from 'node:process'
import {
  readVercelEnvManifest,
  readVercelProjectSettingsManifest,
} from './core/vercel-manifests.mjs'
import { resolveIacContext } from './shared.mjs'

const iacContext = resolveIacContext(process.argv.slice(2), {
  autoCreateKeys: 'landing,web-client,web-server,auth,preview,payment',
  autoCreatePrefixes: 'template-',
})
const tokenFilePath = iacContext.tokenFilePath
const apiBase = 'https://api.vercel.com'
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

function parseArgs(argv) {
  const args = {
    apply: false,
    projects: [],
  }

  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true
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
  }

  return args
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

    return trimmed
  }

  return ''
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

function diffSettings(current, desired) {
  const keys = [
    'rootDirectory',
    'nodeVersion',
    'enableAffectedProjectsDeployments',
  ]
  const patch = {}
  const diffs = []

  for (const key of keys) {
    const currentValue = current[key] ?? null
    const desiredValue = desired[key] ?? null
    if (currentValue !== desiredValue) {
      patch[key] = desiredValue
      diffs.push({ key, current: currentValue, desired: desiredValue })
    }
  }

  return { patch, diffs }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dryRun = !args.apply

  const token =
    process.env.VERCEL_TOKEN ||
    process.env.VERCEL_API_KEY ||
    readTokenFromFile(tokenFilePath)

  if (!dryRun && !token) {
    throw new Error('Missing VERCEL_TOKEN (or VERCEL_API_KEY) for apply mode')
  }

  const envManifest = readVercelEnvManifest(iacContext)
  const projectSettingsManifest = readVercelProjectSettingsManifest(iacContext)

  const configuredProjects = Array.isArray(envManifest.projects)
    ? envManifest.projects
    : []
  const projectSettings = Array.isArray(projectSettingsManifest.projects)
    ? projectSettingsManifest.projects
    : []
  const teamSlug = envManifest.teamSlug
  if (!teamSlug || typeof teamSlug !== 'string') {
    throw new Error('Missing or invalid teamSlug in the env manifest')
  }
  const teamId = token ? await resolveTeamId({ token, teamSlug }) : ''

  const defaultSettings = projectSettingsManifest.defaults || {}

  const projectByKey = new Map(
    configuredProjects
      .filter(
        (project) =>
          typeof project.key === 'string' &&
          typeof project.id === 'string' &&
          project.id.trim().length > 0,
      )
      .map((project) => [project.key, project]),
  )

  if (token && teamId) {
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
            `[plan] ${project.key}: would create Vercel project "${projectName}" because env-manifest id is missing`,
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
          `[created] ${project.key}: created Vercel project "${projectName}" -> ${resolvedId}`,
        )
      }

      if (!resolvedId) continue

      projectByKey.set(project.key, { ...project, id: resolvedId })
      console.log(
        `[resolved] ${project.key}: using Vercel project "${project.name}" -> ${resolvedId}`
      )
    }
  }

  const requested = args.projects.length ? new Set(args.projects) : null

  for (const entry of projectSettings) {
    if (requested && !requested.has(entry.key)) continue

    const configured = projectByKey.get(entry.key)
    if (!configured) {
      console.log(`[skip] ${entry.key}: missing Vercel project ID in env-manifest`)
      continue
    }

    const desired = {
      rootDirectory: entry.rootDirectory ?? defaultSettings.rootDirectory ?? null,
      nodeVersion: entry.nodeVersion ?? defaultSettings.nodeVersion ?? null,
      enableAffectedProjectsDeployments:
        entry.enableAffectedProjectsDeployments ??
        defaultSettings.enableAffectedProjectsDeployments ??
        null,
    }

    if (!token) {
      console.log(
        `[dry-run/offline] ${entry.key}: cannot fetch remote settings without token`,
      )
      continue
    }

    const project = await requestJSON({
      token,
      method: 'GET',
      pathname: `/v9/projects/${encodeURIComponent(configured.id)}`,
      query: { teamId },
    })

    const current = {
      rootDirectory: project.rootDirectory ?? null,
      nodeVersion: project.nodeVersion ?? null,
      enableAffectedProjectsDeployments:
        project.enableAffectedProjectsDeployments ?? null,
    }

    const { patch, diffs } = diffSettings(current, desired)

    if (diffs.length === 0) {
      console.log(`[ok] ${entry.key}: project settings already in sync`)
      continue
    }

    console.log(`[diff] ${entry.key}`)
    for (const change of diffs) {
      console.log(
        `  - ${change.key}: ${JSON.stringify(change.current)} -> ${JSON.stringify(change.desired)}`,
      )
    }

    if (dryRun) continue

    await requestJSON({
      token,
      method: 'PATCH',
      pathname: `/v9/projects/${encodeURIComponent(configured.id)}`,
      query: { teamId },
      body: patch,
    })

    console.log(`[applied] ${entry.key}: updated remote project settings`)
  }
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
