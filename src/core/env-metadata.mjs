import fs from 'node:fs'
import path from 'node:path'

const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

function metadataFileName(manifest = {}) {
  return (
    manifest.env?.metadataFile ||
    manifest.env?.sync?.metadataFile ||
    '.env.json'
  )
}

function metadataSourceKey(baseDir, sourceKey) {
  return sourceKey || path.basename(baseDir)
}

function embeddedMetadata(manifest = {}, sourceKey) {
  const configured = asObject(manifest.env?.metadata || manifest.env?.envJson)
  if (Object.keys(configured).length === 0) return null

  const sources = asObject(configured.sources)
  return sources[sourceKey] || configured[sourceKey] || null
}

function normalizeVariableList(raw, filePath) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.variables)) return raw.variables
  if (asObject(raw?.variables) === raw.variables) {
    return Object.entries(raw.variables).map(([key, config]) => ({
      key,
      ...asObject(config),
    }))
  }
  if (Array.isArray(raw?.env)) return raw.env

  const vars = raw?.vars
  if (Array.isArray(vars)) return vars
  if (asObject(vars) !== vars) {
    throw new Error(`${filePath} must contain a variables array or vars object.`)
  }

  return Object.entries(vars).map(([key, config]) => ({ key, ...asObject(config) }))
}

function asStringList(value, field) {
  if (value === undefined) return []
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())) {
    return value.map((item) => item.trim())
  }
  throw new Error(`${field} must be a non-empty string or array of non-empty strings.`)
}

function manifestPackageKeys(manifest = {}) {
  const configured = Array.isArray(manifest.packages)
    ? manifest.packages
    : Array.isArray(manifest.env?.packages)
      ? manifest.env.packages
      : Array.isArray(manifest.apps)
        ? manifest.apps
        : []
  const keys = []

  for (const item of configured) {
    if (typeof item === 'string' && item.trim()) {
      keys.push(item.trim())
      continue
    }

    const config = asObject(item, null)
    const key = config?.key || config?.name
    if (typeof key === 'string' && key.trim()) keys.push(key.trim())
  }

  return new Set(keys)
}

function normalizePackageList(value, field, packageKeys) {
  if (value === undefined) return []
  const values = Array.isArray(value) ? value : [value]
  const packages = []

  for (const item of values) {
    if (typeof item === 'string' && item.trim()) {
      const packageKey = item.trim()
      if (packageKeys.size > 0 && !packageKeys.has(packageKey)) {
        throw new Error(`${field} references unknown package "${packageKey}".`)
      }
      packages.push({ package: packageKey })
      continue
    }

    const packageRef = asObject(item, null)
    if (!packageRef) {
      throw new Error(`${field} must contain package keys or package objects.`)
    }

    const packageKey = packageRef.package || packageRef.app
    if (typeof packageKey !== 'string' || packageKey.trim() === '') {
      throw new Error(`${field} package entry must define non-empty package.`)
    }
    if (packageKeys.size > 0 && !packageKeys.has(packageKey.trim())) {
      throw new Error(`${field} references unknown package "${packageKey.trim()}".`)
    }

    const outputKey = packageRef.key || packageRef.envKey || packageRef.outputKey || packageRef.name
    if (outputKey !== undefined && (typeof outputKey !== 'string' || !envKeyPattern.test(outputKey))) {
      throw new Error(`${field} package ${packageKey} has invalid output key.`)
    }

    packages.push({
      package: packageKey.trim(),
      key: typeof outputKey === 'string' ? outputKey : undefined,
    })
  }

  return packages
}

function envList(value, field, environments, validEnvironments) {
  const items = asStringList(value, field)
  if (validEnvironments.size === 0) return items

  const available = []
  for (const environment of items) {
    if (validEnvironments.has(environment)) available.push(environment)
  }
  return available
}

function normalizeEnvValues(value, field) {
  if (value === undefined) return {}
  const values = asObject(value, null)
  if (!values) {
    throw new Error(`${field} must be an object of string values.`)
  }

  for (const [environment, envValue] of Object.entries(values)) {
    if (typeof environment !== 'string' || environment.trim() === '') {
      throw new Error(`${field} must use non-empty environment names.`)
    }
    if (typeof envValue !== 'string') {
      throw new Error(`${field}.${environment} must be a string.`)
    }
  }

  return values
}

function normalizeMetadataRows({ rows, label, manifest }) {
  const entries = new Map()
  const environments = Array.isArray(manifest.environments) ? manifest.environments : []
  const validEnvironments = new Set(environments)
  const packageKeys = manifestPackageKeys(manifest)

  for (const row of rows) {
    const item = asObject(row)
    const key = item.key
    if (typeof key !== 'string' || !envKeyPattern.test(key)) {
      throw new Error(`${label} contains an env metadata item with an invalid key.`)
    }
    if (entries.has(key)) {
      throw new Error(`${label} contains duplicate metadata for ${key}.`)
    }
    if (!Object.hasOwn(item, 'example') || typeof item.example !== 'string') {
      throw new Error(`${label} metadata for ${key} must define string example.`)
    }
    if (typeof item.encrypted !== 'boolean') {
      throw new Error(`${label} metadata for ${key} must define boolean encrypted.`)
    }
    if (typeof item.browser !== 'boolean') {
      throw new Error(`${label} metadata for ${key} must define boolean browser.`)
    }
    if (Object.hasOwn(item, 'value') && typeof item.value !== 'string') {
      throw new Error(`${label} metadata for ${key} value must be a string.`)
    }

    const excludeEnv = envList(
      item.excludeEnv,
      `${label} metadata for ${key} excludeEnv`,
      environments,
      validEnvironments,
    )
    const includeEnv = envList(
      item.includeEnv,
      `${label} metadata for ${key} includeEnv`,
      environments,
      validEnvironments,
    )

    entries.set(key, {
      key,
      example: item.example,
      encrypted: item.encrypted,
      browser: item.browser,
      value: typeof item.value === 'string' ? item.value : undefined,
      values: normalizeEnvValues(item.values, `${label} metadata for ${key} values`),
      valuesConfigured: Object.hasOwn(item, 'value') || Object.hasOwn(item, 'values'),
      includeInExample: item.includeInExample !== false,
      excludeEnv,
      includeEnv,
      includeEnvConfigured: Object.hasOwn(item, 'includeEnv'),
      packages: normalizePackageList(
        item.packages,
        `${label} metadata for ${key} packages`,
        packageKeys,
      ),
    })
  }

  return entries
}

export function loadEnvMetadata({ baseDir, manifest, required = false, sourceKey = '' }) {
  const resolvedSourceKey = metadataSourceKey(baseDir, sourceKey)
  const embedded = embeddedMetadata(manifest, resolvedSourceKey)
  if (embedded) {
    const label = `iac.json env.metadata.${resolvedSourceKey}`
    return {
      filePath: label,
      label,
      entries: normalizeMetadataRows({
        rows: normalizeVariableList(embedded, label),
        label,
        manifest,
      }),
      required: true,
    }
  }

  const filePath = path.join(baseDir, metadataFileName(manifest))
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new Error(`Missing required env metadata file: ${filePath}`)
    }
    return { filePath, label: filePath, entries: new Map(), required: false }
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return {
    filePath,
    label: filePath,
    entries: normalizeMetadataRows({
      rows: normalizeVariableList(raw, filePath),
      label: filePath,
      manifest,
    }),
    required: true,
  }
}

export function applyEnvMetadata({ baseDir, entries, manifest, sourceKey = '' }) {
  const metadata = loadEnvMetadata({ baseDir, manifest, sourceKey })
  if (!metadata.required) {
    return entries.map((entry) => ({
      ...entry,
      metadata: null,
      encrypted: true,
      browser: false,
    }))
  }

  return entries.map((entry) => {
    const config = metadata.entries.get(entry.key)
    if (!config) {
      throw new Error(
        `${metadataLabel(metadata)} must define metadata for ${entry.key}.`,
      )
    }
    return {
      ...entry,
      metadata: config,
      encrypted: config.encrypted,
      browser: config.browser,
      includeInExample: config.includeInExample,
      excludeEnv: config.excludeEnv,
      includeEnv: config.includeEnv,
      includeEnvConfigured: config.includeEnvConfigured,
      packages: config.packages,
    }
  })
}

function metadataLabel(metadata) {
  return path.isAbsolute(metadata.filePath)
    ? path.relative(process.cwd(), metadata.filePath)
    : metadata.label || metadata.filePath
}

export function envExampleEntries({ baseDir, manifest, sourceKey = '' }) {
  const metadata = loadEnvMetadata({ baseDir, manifest, sourceKey })
  if (!metadata.required) return []

  return [...metadata.entries.values()]
    .filter((entry) => entry.includeInExample !== false)
    .map(({ key, example }) => ({ key, value: example }))
}

export function manifestEnvEntries({ baseDir, manifest, sourceKey = '', environment }) {
  const metadata = loadEnvMetadata({ baseDir, manifest, sourceKey })
  if (!metadata.required) return null

  const metadataEntries = [...metadata.entries.values()]
  if (!metadataEntries.some((entry) => entry.valuesConfigured)) return null

  const entries = []
  for (const entry of metadataEntries) {
    if (!entry.valuesConfigured) continue
    if (!isAllowedInEnv(entry, environment)) continue

    const hasEnvironmentValue = Object.hasOwn(entry.values, environment)
    const hasDefaultValue = Object.hasOwn(entry.values, 'default')
    const hasValue = entry.value !== undefined
    if (!hasEnvironmentValue && !hasDefaultValue && !hasValue) {
      throw new Error(
        `${metadataLabel(metadata)} metadata for ${entry.key} must define value, values.default, or values.${environment}.`,
      )
    }

    entries.push({
      key: entry.key,
      value: hasEnvironmentValue
        ? entry.values[environment]
        : hasDefaultValue
          ? entry.values.default
          : entry.value,
      metadata: entry,
      encrypted: entry.encrypted,
      browser: entry.browser,
      includeInExample: entry.includeInExample,
      excludeEnv: entry.excludeEnv,
      includeEnv: entry.includeEnv,
      includeEnvConfigured: entry.includeEnvConfigured,
      packages: entry.packages,
    })
  }

  return {
    entries,
    metadata,
    sourceLabel: `${metadataLabel(metadata)} values.${environment}`,
  }
}

export function isExcludedFromEnv(entry, environment) {
  return Array.isArray(entry.excludeEnv) && entry.excludeEnv.includes(environment)
}

export function isAllowedInEnv(entry, environment) {
  if (isExcludedFromEnv(entry, environment)) return false
  if (
    entry.includeEnvConfigured ||
    (Array.isArray(entry.includeEnv) && entry.includeEnv.length > 0)
  ) {
    return entry.includeEnv.includes(environment)
  }
  return true
}

function isBrowserRuntimeKey(key) {
  return (
    key.startsWith('NEXT_PUBLIC_') ||
    key.startsWith('EXPO_PUBLIC_') ||
    key.startsWith('VITE_')
  )
}

export function assertBrowserProjectionAllowed({ entries, prefix, metadataPath }) {
  for (const entry of entries) {
    const projectedKey = prefix && entry.key.startsWith(prefix)
      ? entry.key.slice(prefix.length)
      : entry.key
    if (entry.metadata && isBrowserRuntimeKey(projectedKey) && entry.browser !== true) {
      throw new Error(
        `${metadataPath} marks ${entry.key} as browser=false, but it projects browser key ${projectedKey}.`,
      )
    }
  }
}
