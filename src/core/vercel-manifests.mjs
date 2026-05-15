import fs from 'node:fs'
import { readManifest } from './manifest.mjs'

const projectSettingKeys = [
  'rootDirectory',
  'nodeVersion',
  'enableAffectedProjectsDeployments',
]

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`)
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readUnifiedManifest(context, fallbackPath) {
  if (!fs.existsSync(context.iacManifestPath)) {
    throw new Error(`Missing required file: ${fallbackPath} or ${context.iacManifestPath}`)
  }
  return readManifest(context.iacManifestPath)
}

function readLegacyOrUnified({
  legacyPath,
  explicitLegacyPath,
  context,
  derive,
}) {
  if (fs.existsSync(legacyPath) || explicitLegacyPath) {
    return readJSON(legacyPath)
  }

  return derive(readUnifiedManifest(context, legacyPath))
}

function vercelConfig(manifest) {
  return manifest.providers.vercel || {}
}

function appVercelValues(app) {
  return {
    ...app,
    ...((app.providers && app.providers.vercel) || {}),
  }
}

function teamSlugFromManifest(manifest) {
  const config = vercelConfig(manifest)
  return config.teamSlug || config.team || ''
}

function envSourceDir(manifest) {
  return (
    manifest.env.sourceDir ||
    manifest.env.dir ||
    manifest.env.infraDir ||
    manifest.infraDir ||
    'infrastructure'
  )
}

function configuredProjects(manifest) {
  return manifest.apps.map((app) => {
    const values = appVercelValues(app)
    return {
      key: app.key,
      id: values.id || values.projectId || '',
      name: values.name || app.name || app.key,
    }
  })
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  )
}

function projectSettings(manifest) {
  return manifest.apps.map((app) => {
    const values = appVercelValues(app)
    const entry = { key: app.key }
    for (const key of projectSettingKeys) {
      if (values[key] !== undefined) entry[key] = values[key]
    }
    return entry
  })
}

function domainTarget(domain, fallback) {
  if (fallback) return fallback
  if (!domain || typeof domain !== 'object') return ''
  return domain.app || domain.project || domain.key || ''
}

function domainConfig(domain) {
  if (typeof domain === 'string') return domain
  if (!domain || typeof domain !== 'object') return null

  return compactObject({
    name: domain.name,
    gitBranch: domain.gitBranch,
    verified: domain.verified,
  })
}

function projectDomains(manifest) {
  const domainsByProject = new Map(manifest.apps.map((app) => [app.key, []]))

  for (const app of manifest.apps) {
    const values = appVercelValues(app)
    const domains = Array.isArray(values.domains) ? values.domains : []
    for (const domain of domains) {
      const config = domainConfig(domain)
      if (config) domainsByProject.get(app.key).push(config)
    }
  }

  for (const domain of manifest.domains) {
    const target = domainTarget(domain)
    if (!target) continue
    const config = domainConfig(domain)
    if (!config) continue
    if (!domainsByProject.has(target)) domainsByProject.set(target, [])
    domainsByProject.get(target).push(config)
  }

  return [...domainsByProject.entries()].map(([key, domains]) => ({ key, domains }))
}

export function vercelEnvManifestFromIac(manifest, context = {}) {
  return {
    teamSlug: teamSlugFromManifest(manifest),
    infraDir: context.infraDir || envSourceDir(manifest),
    projects: configuredProjects(manifest),
  }
}

export function vercelProjectSettingsFromIac(manifest) {
  const config = vercelConfig(manifest)
  return compactObject({
    defaults: config.projectDefaults || config.projectSettingsDefaults,
    projects: projectSettings(manifest),
  })
}

export function vercelProjectDomainsFromIac(manifest) {
  return {
    projects: projectDomains(manifest),
  }
}

export function readVercelEnvManifest(context) {
  return readLegacyOrUnified({
    legacyPath: context.manifestPath,
    explicitLegacyPath: context.explicitManifestPath,
    context,
    derive: (manifest) => vercelEnvManifestFromIac(manifest, context),
  })
}

export function readVercelProjectSettingsManifest(context) {
  return readLegacyOrUnified({
    legacyPath: context.projectSettingsPath,
    explicitLegacyPath: context.explicitProjectSettingsPath,
    context,
    derive: vercelProjectSettingsFromIac,
  })
}

export function readVercelProjectDomainsManifest(context) {
  return readLegacyOrUnified({
    legacyPath: context.projectDomainsPath,
    explicitLegacyPath: context.explicitProjectDomainsPath,
    context,
    derive: vercelProjectDomainsFromIac,
  })
}
