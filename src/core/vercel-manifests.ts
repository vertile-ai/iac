import fs from 'node:fs'
import { envSourceDir } from './env-source.js'
import { readManifest } from './manifest.js'

const projectSettingKeys = [
  'rootDirectory',
  'nodeVersion',
  'enableAffectedProjectsDeployments',
]

const protectionBypassOperations = ['ensure', 'generate', 'update', 'revoke']

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`)
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readUnifiedManifest(context) {
  if (!fs.existsSync(context.iacManifestPath)) {
    throw new Error(`Missing required file: ${context.iacManifestPath}`)
  }
  return readManifest(context.iacManifestPath)
}

function readLegacyOrUnified({
  legacyPath,
  explicitLegacyPath,
  context,
  derive,
}) {
  if (explicitLegacyPath) {
    return readJSON(legacyPath)
  }

  if (fs.existsSync(context.iacManifestPath)) {
    return derive(readUnifiedManifest(context))
  }

  if (fs.existsSync(legacyPath)) {
    return readJSON(legacyPath)
  }

  return derive(readUnifiedManifest(context))
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

function isDeployableVercelApp(app) {
  return app.deploy !== false && app.providers?.vercel?.deploy !== false
}

function deployableApps(manifest) {
  return manifest.apps.filter(isDeployableVercelApp)
}

function teamSlugFromManifest(manifest) {
  const config = vercelConfig(manifest)
  return config.teamSlug || config.team || ''
}

function configuredProjects(manifest) {
  return deployableApps(manifest).map((app) => {
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

function projectSettings(manifest: any) {
  const config = vercelConfig(manifest)
  const defaultProtectionBypass = config.protectionBypassForAutomation

  return deployableApps(manifest).map((app) => {
    const values = appVercelValues(app)
    const entry: any = { key: app.key }
    for (const key of projectSettingKeys) {
      if (values[key] !== undefined) entry[key] = values[key]
    }
    const appProtectionBypass = values.protectionBypassForAutomation
    const protectionBypass =
      appProtectionBypass === false
        ? undefined
        : appProtectionBypass || defaultProtectionBypass
    if (protectionBypass !== undefined) {
      entry.protectionBypassForAutomation =
        normalizeProtectionBypassForAutomation(protectionBypass, app.key)
    }
    return entry
  })
}

function normalizeProtectionBypassForAutomation(config, appKey) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(
      `Vercel protectionBypassForAutomation for app "${appKey}" must be an object or false.`,
    )
  }

  const operations = protectionBypassOperations.filter((operation) => config[operation] !== undefined)
  if (operations.length !== 1) {
    throw new Error(
      `Vercel protectionBypassForAutomation for app "${appKey}" must define exactly one of ensure, generate, update, or revoke.`,
    )
  }

  const operation = operations[0]
  const value = config[operation]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Vercel protectionBypassForAutomation.${operation} for app "${appKey}" must be an object.`,
    )
  }

  return { [operation]: { ...value } }
}

function domainTarget(domain, fallback = '') {
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
  const apps = deployableApps(manifest)
  const domainsByProject = new Map<string, any[]>(apps.map((app) => [app.key, []]))

  for (const app of apps) {
    const values = appVercelValues(app)
    const domains = Array.isArray(values.domains) ? values.domains : []
    for (const domain of domains) {
      const config = domainConfig(domain)
      if (config) domainsByProject.get(app.key)!.push(config)
    }
  }

  for (const domain of manifest.domains) {
    const target = domainTarget(domain)
    if (!target) continue
    const config = domainConfig(domain)
    if (!config) continue
    if (!domainsByProject.has(target)) domainsByProject.set(target, [])
    domainsByProject.get(target)!.push(config)
  }

  return [...domainsByProject.entries()].map(([key, domains]) => ({ key, domains }))
}

export function vercelEnvManifestFromIac(manifest, context = {}) {
  const config = vercelConfig(manifest)
  return {
    teamSlug: teamSlugFromManifest(manifest),
    sourceDir: envSourceDir(manifest),
    environments: manifest.environments,
    env: {
      metadata: manifest.env?.metadata,
      metadataFile: manifest.env?.metadataFile,
      sync: {
        metadataFile: manifest.env?.sync?.metadataFile,
      },
    },
    environmentFiles: manifest.environmentFiles || {},
    targets: config.env?.targets || {},
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
  return vercelEnvManifestFromIac(readUnifiedManifest(context), context)
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
