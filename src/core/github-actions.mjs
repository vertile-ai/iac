import path from 'node:path'
import { manifestEnvEntries } from './env-metadata.mjs'

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

function asStringList(value, field) {
  if (value === undefined) return []
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())) {
    return value.map((item) => item.trim())
  }
  throw new Error(`${field} must be a non-empty string or array of non-empty strings.`)
}

function metadataSourceKeys(manifest) {
  const metadata = asObject(manifest.env?.metadata || manifest.env?.envJson)
  const sources = new Set()
  for (const key of Object.keys(asObject(metadata.sources))) sources.add(key)
  for (const key of Object.keys(metadata)) {
    if (key !== 'sources') sources.add(key)
  }
  return [...sources]
}

function collectMetadataValues({ manifest, sourceRoot, environment }) {
  const values = new Map()

  for (const sourceKey of metadataSourceKeys(manifest)) {
    const baseDir = path.join(sourceRoot, sourceKey)
    const layer = manifestEnvEntries({ baseDir, manifest, sourceKey, environment })
    if (!layer) continue

    for (const entry of layer.entries) {
      if (!values.has(entry.key)) {
        values.set(entry.key, {
          key: entry.key,
          value: entry.value,
          encrypted: entry.encrypted,
          sourceKey,
          sourceLabel: layer.sourceLabel,
        })
      }
    }
  }

  return values
}

function normalizePublishItem(item, field) {
  if (typeof item === 'string' && item.trim()) {
    return { source: item.trim(), key: item.trim() }
  }

  const config = asObject(item, null)
  if (!config) {
    throw new Error(`${field} entries must be strings or objects.`)
  }

  const source = config.source || config.from || config.env || config.name || config.key
  const key = config.key || config.name || config.env || source
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error(`${field} entry must define source/from/key.`)
  }
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`${field} entry ${source} has invalid GitHub env key.`)
  }

  return {
    source: source.trim(),
    key: key.trim(),
    secret: typeof config.secret === 'boolean' ? config.secret : undefined,
  }
}

function environmentConfigEntries(actionsConfig) {
  const environments = asObject(actionsConfig.environments)
  return Object.entries(environments).map(([environment, rawConfig]) => ({
    environment,
    config: asObject(rawConfig),
  }))
}

export function buildGitHubActionsPlan({ manifest, sourceRoot, selectedEnvironments = [] }) {
  const github = asObject(manifest.providers.github || manifest.providers.githubActions)
  const actions = asObject(github.actions)
  const configuredEnvironments = environmentConfigEntries(actions)
  const selected = new Set(selectedEnvironments)
  const environments = selected.size
    ? configuredEnvironments.filter(({ environment }) => selected.has(environment))
    : configuredEnvironments

  if (configuredEnvironments.length === 0) {
    throw new Error('iac.json providers.github.actions.environments must define at least one environment.')
  }
  if (selected.size && environments.length !== selected.size) {
    const configured = new Set(configuredEnvironments.map(({ environment }) => environment))
    const missing = [...selected].filter((environment) => !configured.has(environment))
    throw new Error(`Unknown GitHub Actions environment mapping: ${missing.join(', ')}`)
  }

  const repo = github.repository || github.repo || ''
  const plan = {
    repo,
    environments: [],
  }

  for (const { environment, config } of environments) {
    if (!manifest.environments.includes(environment)) {
      throw new Error(
        `providers.github.actions.environments.${environment} must match one of: ${manifest.environments.join(', ')}`,
      )
    }

    const metadataValues = collectMetadataValues({ manifest, sourceRoot, environment })
    const publishItems = [
      ...asStringList(actions.variables, 'providers.github.actions.variables').map((key) => ({
        source: key,
        key,
        secret: false,
      })),
      ...asStringList(actions.secrets, 'providers.github.actions.secrets').map((key) => ({ source: key, key, secret: true })),
      ...(Array.isArray(actions.env) ? actions.env.map((item) => normalizePublishItem(item, 'providers.github.actions.env')) : []),
      ...asStringList(config.variables, `providers.github.actions.environments.${environment}.variables`).map((key) => ({
        source: key,
        key,
        secret: false,
      })),
      ...asStringList(config.secrets, `providers.github.actions.environments.${environment}.secrets`).map((key) => ({ source: key, key, secret: true })),
      ...(Array.isArray(config.env)
        ? config.env.map((item) =>
            normalizePublishItem(item, `providers.github.actions.environments.${environment}.env`),
          )
        : []),
    ]

    const outputs = []
    for (const item of publishItems) {
      const source = metadataValues.get(item.source)
      if (!source) {
        throw new Error(
          `providers.github.actions.environments.${environment} references unknown env metadata key ${item.source}.`,
        )
      }

      outputs.push({
        source: item.source,
        key: item.key,
        value: source.value,
        secret: item.secret ?? source.encrypted,
      })
    }

    plan.environments.push({
      environment,
      name: config.name || config.githubEnvironment || environment,
      branches: asStringList(config.branches ?? config.branch, `providers.github.actions.environments.${environment}.branches`),
      outputs,
    })
  }

  return plan
}
