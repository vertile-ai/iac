import fs from 'node:fs'

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

function normalizeProject(project) {
  if (typeof project === 'string') return { name: project }
  const normalized = asObject(project)
  return {
    name: normalized.name || normalized.key || 'project',
    ...normalized,
  }
}

function normalizeApp(app) {
  const normalized = asObject(app)
  if (!normalized.key) {
    throw new Error('Each iac.json app must include a key.')
  }

  return {
    name: normalized.name || normalized.key,
    ...normalized,
  }
}

function normalizeKeyedList(manifest, field) {
  if (!Array.isArray(manifest[field])) return []

  return manifest[field].map((item) => {
    const normalized = asObject(item)
    if (!normalized.key) {
      throw new Error(`Each iac.json ${field} item must include a key.`)
    }
    return normalized
  })
}

function assertStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`iac.json ${field} must be an array of non-empty strings.`)
  }
}

function validateProviderResources(providers) {
  for (const [provider, config] of Object.entries(providers)) {
    const resources = config && Array.isArray(config.resources) ? config.resources : []
    for (const resource of resources) {
      if (!resource.type || !resource.name) {
        throw new Error(
          `iac.json providers.${provider}.resources items must include type and name.`,
        )
      }
    }
  }
}

export function validateManifest(manifest) {
  if (manifest.version !== 1) {
    throw new Error(`Unsupported iac.json version "${manifest.version}". Expected version 1.`)
  }
  if (!manifest.project.name || typeof manifest.project.name !== 'string') {
    throw new Error('iac.json project.name must be a non-empty string.')
  }
  assertStringArray(manifest.environments, 'environments')
  validateProviderResources(manifest.providers)
}

export function normalizeManifest(rawManifest) {
  const manifest = asObject(rawManifest)
  const environments = Array.isArray(manifest.environments)
    ? manifest.environments
    : ['development', 'preview', 'production']

  const normalized = {
    version: manifest.version || 1,
    project: normalizeProject(manifest.project),
    environments,
    providers: asObject(manifest.providers),
    apps: Array.isArray(manifest.apps) ? manifest.apps.map(normalizeApp) : [],
    domains: Array.isArray(manifest.domains) ? manifest.domains : [],
    infraDir: manifest.infraDir,
    objectStorage: normalizeKeyedList(manifest, 'objectStorage'),
    databases: normalizeKeyedList(manifest, 'databases'),
    queues: normalizeKeyedList(manifest, 'queues'),
    sandboxes: normalizeKeyedList(manifest, 'sandboxes'),
    clusters: normalizeKeyedList(manifest, 'clusters'),
    env: asObject(manifest.env),
  }

  validateManifest(normalized)
  return normalized
}

export function readManifest(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required iac manifest: ${filePath}`)
  }

  return normalizeManifest(JSON.parse(fs.readFileSync(filePath, 'utf8')))
}

export function assertEnvironment(manifest, environment) {
  if (!manifest.environments.includes(environment)) {
    throw new Error(
      `Unknown environment "${environment}". Use one of: ${manifest.environments.join(', ')}`,
    )
  }
}
