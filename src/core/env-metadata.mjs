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

function envList(value, field, environments, validEnvironments) {
  const items = asStringList(value, field)
  if (validEnvironments.size === 0) return items

  const available = []
  for (const environment of items) {
    if (validEnvironments.has(environment)) available.push(environment)
  }
  return available
}

function normalizeMetadataRows({ rows, label, manifest }) {
  const entries = new Map()
  const environments = Array.isArray(manifest.environments) ? manifest.environments : []
  const validEnvironments = new Set(environments)

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
      includeInExample: item.includeInExample !== false,
      excludeEnv,
      includeEnv,
      includeEnvConfigured: Object.hasOwn(item, 'includeEnv'),
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
