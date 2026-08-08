import fs from 'node:fs'
import { isIP } from 'node:net'
import { sanitizeName } from './hcl.js'

function asObject(value: any, fallback: any = {}): any {
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

function assertUniqueNonEmptyStringArray(value, field) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.trim() === '')
    || new Set(value).size !== value.length
  ) {
    throw new Error(`iac.json ${field} must be a non-empty array of unique non-empty strings.`)
  }
}

function assertOptionalNonEmptyString(value, field) {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`iac.json ${field} must be a non-empty string.`)
  }
}

function assertOptionalBoolean(value, field) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`iac.json ${field} must be a boolean.`)
  }
}

function isDigitalOceanRegionSlug(value) {
  return typeof value === 'string' && /^[a-z0-9]+$/.test(value)
}

function assertDigitalOceanRegionSlug(value, field) {
  if (!isDigitalOceanRegionSlug(value)) {
    throw new Error(`iac.json ${field} must be a lowercase DigitalOcean region slug using only ASCII letters and digits.`)
  }
}

function isDigitalOceanBucketName(value) {
  return typeof value === 'string'
    && value.length >= 3
    && value.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
}

function assertDigitalOceanBucketName(value, field) {
  if (!isDigitalOceanBucketName(value)) {
    throw new Error(
      `iac.json ${field} must be a valid DigitalOcean Spaces bucket name: 3-63 lowercase letters, digits, or dashes; it must begin and end with a letter or digit.`,
    )
  }
}

function isSafeStateKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (value !== value.trim()) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false
  if (value.startsWith('/') || value.endsWith('/')) return false

  const segments = value.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function assertOptionalSafeStateKey(value, field) {
  if (value !== undefined && !isSafeStateKey(value)) {
    throw new Error(
      `iac.json ${field} must be a non-empty safe relative object key using only ASCII letters, digits, ".", "_", "-", and "/", without leading "/", trailing "/", empty segments, ".", or ".." path segments.`,
    )
  }
}

function normalizeEnvironments(environments) {
  if (Array.isArray(environments)) {
    return {
      names: environments,
      files: {},
    }
  }

  const configured = asObject(environments)
  if (Object.keys(configured).length === 0) {
    return {
      names: ['development', 'preview', 'production'],
      files: {},
    }
  }

  return {
    names: Object.keys(configured),
    files: configured,
  }
}

function validateProviderResources(providers: any) {
  for (const [provider, config] of Object.entries(providers as Record<string, any>)) {
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

function validateProviderDeployments(manifest: any) {
  for (const [provider, config] of Object.entries(manifest.providers as Record<string, any>)) {
    const deployments = asObject(config.deployments)
    for (const [name, deployment] of Object.entries(deployments)) {
      const values = asObject(deployment)
      const environment = values.environment
      if (environment && !manifest.environments.includes(environment)) {
        throw new Error(
          `iac.json providers.${provider}.deployments.${name}.environment must be one of: ${manifest.environments.join(', ')}`,
        )
      }
      if (provider === 'digitalocean') {
        assertOptionalSafeStateKey(values.stateKey, `providers.${provider}.deployments.${name}.stateKey`)
      }
    }
  }
}

function validateDigitalOceanProviderConfig(manifest: any) {
  const digitalOcean = manifest.providers.digitalocean
  if (digitalOcean === undefined) return
  if (!digitalOcean || typeof digitalOcean !== 'object' || Array.isArray(digitalOcean)) {
    throw new Error('iac.json providers.digitalocean must be an object.')
  }
  assertOptionalNonEmptyString(digitalOcean.region, 'providers.digitalocean.region')
  if (digitalOcean.backend !== undefined) {
    validateDigitalOceanBackend(digitalOcean.backend)
  }
}

function isCredentialLikeBackendField(field) {
  return /(credential|access|secret|token|profile)/i.test(field)
}

function validateDigitalOceanBackend(backend) {
  if (!backend || typeof backend !== 'object' || Array.isArray(backend)) {
    throw new Error('iac.json providers.digitalocean.backend must be an object.')
  }

  const supported = new Set(['type', 'bucket', 'region', 'useLockfile'])
  for (const field of Object.keys(backend)) {
    if (isCredentialLikeBackendField(field)) {
      throw new Error(
        `iac.json providers.digitalocean.backend.${field} must not be configured. Use AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables for Spaces backend credentials.`,
      )
    }
    if (!supported.has(field)) {
      throw new Error(
        `iac.json providers.digitalocean.backend.${field} is not supported. Supported backend fields are: type, bucket, region, useLockfile.`,
      )
    }
  }

  if (backend.type !== 'spaces') {
    throw new Error('iac.json providers.digitalocean.backend.type must be "spaces".')
  }
  assertOptionalNonEmptyString(backend.bucket, 'providers.digitalocean.backend.bucket')
  assertOptionalNonEmptyString(backend.region, 'providers.digitalocean.backend.region')
  if (backend.bucket === undefined) {
    throw new Error('iac.json providers.digitalocean.backend.bucket must be a non-empty string.')
  }
  assertDigitalOceanBucketName(backend.bucket, 'providers.digitalocean.backend.bucket')
  if (backend.region === undefined) {
    throw new Error('iac.json providers.digitalocean.backend.region must be a non-empty string.')
  }
  assertDigitalOceanRegionSlug(backend.region, 'providers.digitalocean.backend.region')
  assertOptionalBoolean(backend.useLockfile, 'providers.digitalocean.backend.useLockfile')
}

function validateObjectStorage(manifest) {
  for (const item of manifest.objectStorage || []) {
    if (item.visibility !== undefined && !['private', 'public'].includes(item.visibility)) {
      throw new Error(`iac.json objectStorage.${item.key}.visibility must be "private" or "public".`)
    }
    const providers = asObject(item.providers)
    const digitalOcean = asObject(providers.digitalocean)
    const configuredName = digitalOcean.name ?? digitalOcean.bucket
    if (configuredName !== undefined) {
      assertDigitalOceanBucketName(
        configuredName,
        `objectStorage.${item.key}.providers.digitalocean.${digitalOcean.name !== undefined ? 'name' : 'bucket'}`,
      )
    }
    if (digitalOcean.acl !== undefined && !['private', 'public-read'].includes(digitalOcean.acl)) {
      throw new Error(
        `iac.json objectStorage.${item.key}.providers.digitalocean.acl must be "private" or "public-read".`,
      )
    }
    if (digitalOcean.region !== undefined) {
      assertDigitalOceanRegionSlug(
        digitalOcean.region,
        `objectStorage.${item.key}.providers.digitalocean.region`,
      )
    }
  }
}

function normalizeDigitalOceanProvider(provider) {
  if (provider === undefined) return undefined
  const normalized = asObject(provider)
  if (
    normalized.backend === undefined
    || !normalized.backend
    || typeof normalized.backend !== 'object'
    || Array.isArray(normalized.backend)
  ) return normalized

  return {
    ...normalized,
    backend: {
      ...normalized.backend,
      useLockfile: normalized.backend.useLockfile ?? true,
    },
  }
}

function normalizeProviderConfigs(providers) {
  const normalized = asObject(providers)
  const digitalocean = normalizeDigitalOceanProvider(normalized.digitalocean)
  return {
    ...normalized,
    ...(digitalocean ? { digitalocean } : {}),
  }
}

function isValidCidr(value: string) {
  const parts = value.split('/')
  if (parts.length !== 2) return false

  const [address, prefixText] = parts
  const ipVersion = isIP(address)
  if (ipVersion === 0 || !/^\d+$/.test(prefixText)) return false

  const prefix = Number(prefixText)
  const maxPrefix = ipVersion === 4 ? 32 : 128
  return prefix >= 0 && prefix <= maxPrefix
}

function isGlobalCidr(value: string) {
  const parts = value.split('/')
  if (parts.length !== 2) return false

  const [address, prefixText] = parts
  return isIP(address) !== 0 && /^\d+$/.test(prefixText) && Number(prefixText) === 0
}

function assertServiceManagementCidrs(value, field) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.trim() === '')
    || new Set(value).size !== value.length
  ) {
    throw new Error(`iac.json ${field} must be a non-empty array of unique CIDR strings.`)
  }
  if (value.some((item) => !isValidCidr(item))) {
    throw new Error(`iac.json ${field} must contain valid CIDR ranges.`)
  }
  if (value.some((item) => isGlobalCidr(item))) {
    throw new Error(`iac.json ${field} must not include global CIDR ranges.`)
  }
}

function normalizeServiceDigitalOceanProvider(config, serviceKey) {
  if (config === undefined) return undefined
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`iac.json services.${serviceKey}.providers.digitalocean must be an object.`)
  }

  if (config.mode !== undefined && config.mode !== 'droplet') {
    throw new Error(`iac.json services.${serviceKey}.providers.digitalocean.mode must be "droplet".`)
  }
  if (config.reservedIp === false) {
    throw new Error(`iac.json services.${serviceKey}.providers.digitalocean.reservedIp false is not supported in v1.`)
  }

  assertOptionalNonEmptyString(config.region, `services.${serviceKey}.providers.digitalocean.region`)
  assertOptionalNonEmptyString(config.sizeSlug, `services.${serviceKey}.providers.digitalocean.sizeSlug`)
  assertOptionalNonEmptyString(config.image, `services.${serviceKey}.providers.digitalocean.image`)
  assertOptionalBoolean(config.backups, `services.${serviceKey}.providers.digitalocean.backups`)
  assertOptionalBoolean(config.monitoring, `services.${serviceKey}.providers.digitalocean.monitoring`)
  if (config.reservedIp !== undefined && typeof config.reservedIp !== 'boolean') {
    throw new Error(`iac.json services.${serviceKey}.providers.digitalocean.reservedIp must be a boolean.`)
  }
  if (config.sshKeyFingerprints !== undefined) {
    assertUniqueNonEmptyStringArray(
      config.sshKeyFingerprints,
      `services.${serviceKey}.providers.digitalocean.sshKeyFingerprints`,
    )
  }
  if (config.managementCidrs !== undefined) {
    assertServiceManagementCidrs(
      config.managementCidrs,
      `services.${serviceKey}.providers.digitalocean.managementCidrs`,
    )
  }

  return {
    ...config,
    mode: config.mode || 'droplet',
    reservedIp: config.reservedIp ?? true,
  }
}

function normalizeService(service, appKeys) {
  const normalized = asObject(service)
  if (typeof normalized.key !== 'string' || normalized.key.trim() === '') {
    throw new Error('Each iac.json services item must include a non-empty key.')
  }

  const serviceKey = normalized.key
  if (normalized.app !== undefined && !appKeys.has(normalized.app)) {
    throw new Error(`iac.json services.${serviceKey}.app must reference an apps[].key.`)
  }
  if (normalized.runtime !== 'container') {
    throw new Error(`iac.json services.${serviceKey}.runtime must be "container".`)
  }
  if ('protocol' in normalized) {
    throw new Error(`iac.json services.${serviceKey}.protocol is not supported in v1.`)
  }
  if (!Number.isInteger(normalized.port) || normalized.port < 1 || normalized.port > 65535) {
    throw new Error(`iac.json services.${serviceKey}.port must be an integer from 1 to 65535.`)
  }
  if (normalized.public === false) {
    throw new Error(`iac.json services.${serviceKey}.public false is not supported in v1.`)
  }
  if (normalized.public !== undefined && typeof normalized.public !== 'boolean') {
    throw new Error(`iac.json services.${serviceKey}.public must be a boolean.`)
  }
  if (normalized.replicas !== undefined && normalized.replicas !== 1) {
    throw new Error(`iac.json services.${serviceKey}.replicas must be 1 in v1.`)
  }

  const healthCheck = normalized.healthCheck === undefined ? undefined : asObject(normalized.healthCheck, null)
  if (healthCheck === null) {
    throw new Error(`iac.json services.${serviceKey}.healthCheck must be an object.`)
  }
  if (
    healthCheck?.path !== undefined
    && (typeof healthCheck.path !== 'string' || !healthCheck.path.startsWith('/'))
  ) {
    throw new Error(`iac.json services.${serviceKey}.healthCheck.path must be an absolute path beginning with "/".`)
  }

  if (
    normalized.providers !== undefined
    && (!normalized.providers || typeof normalized.providers !== 'object' || Array.isArray(normalized.providers))
  ) {
    throw new Error(`iac.json services.${serviceKey}.providers must be an object.`)
  }
  const providers = asObject(normalized.providers)
  const digitalOcean = normalizeServiceDigitalOceanProvider(providers.digitalocean, serviceKey)
  const normalizedProviders = {
    ...providers,
    ...(digitalOcean ? { digitalocean: digitalOcean } : {}),
  }

  return {
    ...normalized,
    public: normalized.public ?? true,
    replicas: normalized.replicas ?? 1,
    ...(healthCheck ? { healthCheck } : {}),
    providers: normalizedProviders,
  }
}

function normalizeServices(manifest, apps) {
  if (manifest.services === undefined) return []
  if (!Array.isArray(manifest.services)) {
    throw new Error('iac.json services must be an array.')
  }

  const appKeys = new Set(apps.map((app) => app.key))
  const services = manifest.services.map((service) => normalizeService(service, appKeys))
  const keys = new Map()
  const sanitizedKeys = new Map()

  for (const service of services) {
    if (keys.has(service.key)) {
      throw new Error(`Duplicate iac.json services key "${service.key}".`)
    }
    keys.set(service.key, service)

    const sanitizedKey = sanitizeName(service.key)
    const existing = sanitizedKeys.get(sanitizedKey)
    if (existing) {
      throw new Error(
        `iac.json services keys "${existing}" and "${service.key}" collide after Terraform name sanitization.`,
      )
    }
    sanitizedKeys.set(sanitizedKey, service.key)
  }

  return services
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
  validateProviderDeployments(manifest)
  validateDigitalOceanProviderConfig(manifest)
  validateObjectStorage(manifest)
}

export function normalizeManifest(rawManifest) {
  const manifest = asObject(rawManifest)
  const environments = normalizeEnvironments(manifest.environments)
  const apps = Array.isArray(manifest.apps) ? manifest.apps.map(normalizeApp) : []

  const normalized = {
    version: manifest.version || 1,
    project: normalizeProject(manifest.project),
    environments: environments.names,
    environmentsDeclared: Object.hasOwn(manifest, 'environments'),
    environmentFiles: environments.files,
    providers: normalizeProviderConfigs(manifest.providers),
    apps,
    packages: normalizeKeyedList(manifest, 'packages'),
    services: normalizeServices(manifest, apps),
    domains: Array.isArray(manifest.domains) ? manifest.domains : [],
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
