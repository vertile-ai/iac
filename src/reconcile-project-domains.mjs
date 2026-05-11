#!/usr/bin/env node

import fs from 'node:fs'
import process from 'node:process'
import { resolveIacContext } from './shared.mjs'

const iacContext = resolveIacContext(process.argv.slice(2), {
  autoCreateKeys: 'landing,web-client,web-server,auth,preview,payment',
  autoCreatePrefixes: 'template-',
})
const envManifestPath = iacContext.manifestPath
const projectDomainsPath = iacContext.projectDomainsPath
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
    reconcileDelete: false,
    skipNewDomainVerify: false,
  }

  for (const arg of argv) {
    if (arg === '--apply') {
      args.apply = true
      continue
    }

    if (arg === '--reconcile-delete') {
      args.reconcileDelete = true
      continue
    }

    if (arg === '--skip-new-domain-verify') {
      args.skipNewDomainVerify = true
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

async function request({
  token,
  method,
  pathname,
  query,
  body,
  acceptedStatus = [200],
}) {
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

    const text = await response.text()
    const payload = text ? (() => {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    })() : {}

    if (acceptedStatus.includes(response.status)) {
      if (defaultThrottleMs > 0) await sleep(defaultThrottleMs)
      return { status: response.status, payload }
    }

    if (response.status === 429 && attempt < maxRequestAttempts - 1) {
      const delayMs = readRetryAfterMs(response, attempt)
      console.warn(
        `[rate-limit] Vercel API ${method} ${pathname} returned 429; retrying in ${Math.ceil(delayMs / 1000)}s`,
      )
      await sleep(delayMs)
      continue
    }

    throw new Error(
      `Vercel API ${method} ${pathname} failed (${response.status}): ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`,
    )
  }

  throw new Error(`Vercel API ${method} ${pathname} failed after retries`)
}

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`)
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

async function resolveTeamId({ token, teamSlug }) {
  const result = await request({
    token,
    method: 'GET',
    pathname: '/v1/teams',
  })
  const rows = Array.isArray(result.payload?.teams) ? result.payload.teams : []
  const match = rows.find((team) => team?.slug === teamSlug)
  if (!match?.id) {
    throw new Error(`Unable to resolve team ID for slug "${teamSlug}"`)
  }
  return match.id
}

async function listTeamProjects({ token, teamId }) {
  const result = await request({
    token,
    method: 'GET',
    pathname: '/v9/projects',
    query: { teamId, limit: 100 },
  })
  return Array.isArray(result.payload?.projects) ? result.payload.projects : []
}

async function createTeamProject({ token, teamId, name }) {
  const result = await request({
    token,
    method: 'POST',
    pathname: '/v10/projects',
    query: { teamId },
    body: { name },
  })

  const project = result.payload
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

function normalizeDomainConfigs(domains) {
  const list = Array.isArray(domains) ? domains : []
  const byName = new Map()

  for (const domain of list) {
    const config =
      typeof domain === 'string'
        ? { name: domain }
        : domain && typeof domain === 'object'
          ? domain
          : null
    const name =
      typeof config?.name === 'string' ? config.name.trim().toLowerCase() : ''
    if (!name) continue

    byName.set(name, {
      name,
      gitBranch:
        typeof config.gitBranch === 'string' && config.gitBranch.trim()
          ? config.gitBranch.trim()
          : null,
      verified: typeof config.verified === 'boolean' ? config.verified : true,
    })
  }

  return [...byName.values()]
}

function computeDiff({ desired, current, reconcileDelete }) {
  const desiredByName = new Map(desired.map((domain) => [domain.name, domain]))
  const currentByName = new Map(current.map((domain) => [domain.name, domain]))

  const toAdd = desired.filter((domain) => !currentByName.has(domain.name))
  const toUpdate = desired.filter((domain) => {
    const currentDomain = currentByName.get(domain.name)
    if (!currentDomain) return false

    return domain.gitBranch !== currentDomain.gitBranch
  })
  const toVerify = desired.filter((domain) => {
    const currentDomain = currentByName.get(domain.name)
    return currentDomain?.verified === false
  })
  const toRemove = reconcileDelete
    ? current.filter((domain) => !desiredByName.has(domain.name))
    : []

  return { toAdd, toUpdate, toVerify, toRemove }
}

function domainLabel(domain) {
  const details = [domain.gitBranch ? `branch=${domain.gitBranch}` : ''].filter(Boolean)

  return details.length ? `${domain.name} (${details.join(', ')})` : domain.name
}

function domainCreateBody(domain) {
  return {
    name: domain.name,
    gitBranch: domain.gitBranch,
  }
}

function domainUpdateBody(domain) {
  return {
    gitBranch: domain.gitBranch,
  }
}

function printVerificationChallenges(domain, payload) {
  const verification = Array.isArray(payload?.verification) ? payload.verification : []
  if (verification.length === 0) return

  console.log(`  [verify] ${domain} requires DNS verification`)
  for (const challenge of verification) {
    const type = challenge?.type || 'UNKNOWN'
    const host = challenge?.domain || '<domain>'
    const value = challenge?.value || '<value>'
    console.log(`    - ${type} ${host} -> ${value}`)
  }
}

async function verifyProjectDomain({ token, configured, teamSlug, domain }) {
  const result = await request({
    token,
    method: 'POST',
    pathname: `/v9/projects/${encodeURIComponent(configured.id)}/domains/${encodeURIComponent(domain.name)}/verify`,
    query: { slug: teamSlug },
    acceptedStatus: [200, 400, 403, 409],
  })

  if (result.status === 200) {
    console.log(`  [applied] ${configured.key}: verified ${domain.name}`)
    return
  }

  const message =
    typeof result.payload?.error?.message === 'string'
      ? result.payload.error.message
      : typeof result.payload?.message === 'string'
        ? result.payload.message
        : JSON.stringify(result.payload)

  console.log(`  [verify] ${domain.name} is still pending DNS verification: ${message}`)
  printVerificationChallenges(domain.name, result.payload)
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

  const envManifest = readJSON(envManifestPath)
  const projectDomainsManifest = readJSON(projectDomainsPath)

  const configuredProjects = Array.isArray(envManifest.projects)
    ? envManifest.projects
    : []
  const projectDomains = Array.isArray(projectDomainsManifest.projects)
    ? projectDomainsManifest.projects
    : []

  const teamSlug = envManifest.teamSlug
  if (!teamSlug || typeof teamSlug !== 'string') {
    throw new Error('Missing or invalid teamSlug in the env manifest')
  }
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

  if (token) {
    const teamId = await resolveTeamId({ token, teamSlug })
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
          `[created] ${project.key}: created Vercel project "${projectName}" -> ${resolvedId}`
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

  for (const entry of projectDomains) {
    if (!entry || typeof entry.key !== 'string') continue
    if (requested && !requested.has(entry.key)) continue

    const configured = projectByKey.get(entry.key)
    if (!configured) {
      console.log(`[skip] ${entry.key}: missing Vercel project ID in env-manifest`)
      continue
    }

    const desiredDomains = normalizeDomainConfigs(entry.domains)
    if (desiredDomains.length === 0) {
      console.log(`[skip] ${entry.key}: no desired domains configured`)
      continue
    }

    if (!token) {
      console.log(
        `[dry-run/offline] ${entry.key}: cannot fetch remote domains without token (desired: ${desiredDomains.map(domainLabel).join(', ')})`,
      )
      continue
    }

    const { payload } = await request({
      token,
      method: 'GET',
      pathname: `/v9/projects/${encodeURIComponent(configured.id)}/domains`,
      query: { slug: teamSlug, redirects: 'false' },
    })
    const currentDomains = normalizeDomainConfigs(
      (Array.isArray(payload?.domains) ? payload.domains : []).map((domain) => ({
        name: domain?.name,
        gitBranch: domain?.gitBranch,
        verified: domain?.verified,
      })),
    )

    const { toAdd, toUpdate, toVerify, toRemove } = computeDiff({
      desired: desiredDomains,
      current: currentDomains,
      reconcileDelete: args.reconcileDelete,
    })

    if (
      toAdd.length === 0 &&
      toUpdate.length === 0 &&
      toVerify.length === 0 &&
      toRemove.length === 0
    ) {
      console.log(`[ok] ${entry.key}: project domains already in sync`)
      continue
    }

    console.log(`[diff] ${entry.key}`)
    if (toAdd.length > 0) {
      console.log(`  - add: ${toAdd.map(domainLabel).join(', ')}`)
    }
    if (toUpdate.length > 0) {
      console.log(`  - update: ${toUpdate.map(domainLabel).join(', ')}`)
    }
    if (toVerify.length > 0) {
      console.log(`  - verify: ${toVerify.map((domain) => domain.name).join(', ')}`)
    }
    if (toRemove.length > 0) {
      console.log(`  - remove: ${toRemove.map((domain) => domain.name).join(', ')}`)
    }

    if (dryRun) continue

    for (const domain of toAdd) {
      const result = await request({
        token,
        method: 'POST',
        pathname: `/v10/projects/${encodeURIComponent(configured.id)}/domains`,
        query: { slug: teamSlug },
        body: domainCreateBody(domain),
        acceptedStatus: [200, 201],
      })

      console.log(`  [applied] ${entry.key}: added ${domainLabel(domain)}`)
      printVerificationChallenges(domain.name, result.payload)
      if (result.payload?.verified === false) {
        if (args.skipNewDomainVerify) {
          console.log(
            `  [verify] ${domain.name} added but not verified yet; rerun apply after DNS propagates`,
          )
        } else {
          await verifyProjectDomain({ token, configured, teamSlug, domain })
        }
      }
    }

    for (const domain of toUpdate) {
      await request({
        token,
        method: 'PATCH',
        pathname: `/v9/projects/${encodeURIComponent(configured.id)}/domains/${encodeURIComponent(domain.name)}`,
        query: { slug: teamSlug },
        body: domainUpdateBody(domain),
      })
      console.log(`  [applied] ${entry.key}: updated ${domainLabel(domain)}`)
    }

    for (const domain of toVerify) {
      await verifyProjectDomain({ token, configured, teamSlug, domain })
    }

    for (const domain of toRemove) {
      await request({
        token,
        method: 'DELETE',
        pathname: `/v9/projects/${encodeURIComponent(configured.id)}/domains/${encodeURIComponent(domain.name)}`,
        query: { slug: teamSlug },
        acceptedStatus: [200, 204, 404],
      })
      console.log(`  [applied] ${entry.key}: removed ${domain.name}`)
    }
  }
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
