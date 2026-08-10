import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { configuredEnvMetadataSourceKeys, loadEnvMetadata } from './env-metadata.js'

function isObject(value: any): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asObject(value: any): any {
  return isObject(value) ? value : {}
}

export function defaultPrivateValuesPath(repoRoot) {
  return path.join(repoRoot, '.vertile-iac', 'private.json')
}

function assertAllowedPrivateProviderFields(privateManifest) {
  if (privateManifest.providers !== undefined && !isObject(privateManifest.providers)) {
    throw new Error('private.json providers must be an object.')
  }
  const providers = asObject(privateManifest.providers)
  const allowedFields = {
    vercel: new Set(['token', 'apiKey', 'protectionBypassForAutomation']),
    github: new Set(['token']),
  }

  for (const [provider, config] of Object.entries(providers)) {
    const fields = allowedFields[provider]
    if (!fields) {
      throw new Error(`private.json providers.${provider} is not allowed.`)
    }
    if (!isObject(config)) {
      throw new Error(`private.json providers.${provider} must be an object.`)
    }
    for (const field of Object.keys(config)) {
      if (!fields.has(field)) {
        throw new Error(`private.json providers.${provider}.${field} is not allowed.`)
      }
      if (field !== 'protectionBypassForAutomation' && typeof config[field] !== 'string') {
        throw new Error(`private.json providers.${provider}.${field} must be a string.`)
      }
    }
    if (provider === 'vercel') assertVercelPrivateProviderFields(config)
  }
}

function assertVercelPrivateProviderFields(config) {
  const bypass = config.protectionBypassForAutomation
  if (bypass === undefined) return
  if (!isObject(bypass)) {
    throw new Error('private.json providers.vercel.protectionBypassForAutomation must be an object.')
  }
  for (const operation of Object.keys(bypass)) {
    if (operation !== 'ensure') {
      throw new Error(`private.json providers.vercel.protectionBypassForAutomation.${operation} is not allowed.`)
    }
  }

  const ensure = bypass.ensure
  if (!isObject(ensure)) {
    throw new Error('private.json providers.vercel.protectionBypassForAutomation.ensure must be an object.')
  }
  for (const field of Object.keys(ensure)) {
    if (field !== 'secret') {
      throw new Error(`private.json providers.vercel.protectionBypassForAutomation.ensure.${field} is not allowed.`)
    }
  }
  if (typeof ensure.secret !== 'string') {
    throw new Error('private.json providers.vercel.protectionBypassForAutomation.ensure.secret must be a string.')
  }
}

function assertPrivateValuesVersion(privateManifest) {
  if (privateManifest.version !== 1) {
    throw new Error('private.json version must be 1.')
  }
}

function assertPrivateDocumentFields(privateManifest) {
  const allowed = new Set(['version', 'env', 'providers'])
  for (const key of Object.keys(privateManifest)) {
    if (!allowed.has(key)) throw new Error(`private.json ${key} is not allowed.`)
  }
}

function isGitWorktree(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  })
  return result.status === 0 && result.stdout.trim() === 'true'
}

function assertPrivateFileIsNotTracked({ repoRoot, filePath }) {
  if (!isGitWorktree(repoRoot)) return

  const relativePath = path.relative(repoRoot, filePath)
  const result = spawnSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', relativePath], {
    encoding: 'utf8',
  })
  if (result.status === 0) {
    throw new Error(`Private values file is tracked by Git: ${relativePath}.`)
  }

  const ignored = spawnSync('git', ['-C', repoRoot, 'check-ignore', '--quiet', '--', relativePath], {
    encoding: 'utf8',
  })
  if (ignored.status !== 0) {
    throw new Error(
      `Private values file is not Git-ignored: ${relativePath}. Add "/${relativePath}" to .gitignore.`,
    )
  }
}

function assertPrivateFileMode(filePath) {
  if (process.platform === 'win32') return

  if ((fs.statSync(filePath).mode & 0o077) !== 0) {
    throw new Error(`Private values file must not be readable by group or others: ${filePath}. Use mode 0600.`)
  }
}

function nestedStringValue(source, field) {
  let value = source
  for (const segment of String(field || '').split('.')) {
    if (!segment || !isObject(value)) return undefined
    value = value[segment]
  }
  return typeof value === 'string' && value.trim() ? value : undefined
}

function processProviderCredential(env, provider, field) {
  const names = provider === 'vercel'
    ? field === 'apiKey'
      ? ['VERCEL_API_KEY', 'VERCEL_TOKEN']
      : field === 'token'
        ? ['VERCEL_TOKEN', 'VERCEL_API_KEY']
        : []
    : provider === 'github' && field === 'token'
      ? ['GH_TOKEN', 'GITHUB_TOKEN']
      : []

  for (const name of names) {
    const value = env?.[name]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function resolveProviderCredential({ manifest, privateManifest, env, provider, field }: any) {
  const processCredential = processProviderCredential(env, provider, field)
  if (processCredential) return processCredential

  const privateCredential = nestedStringValue(privateManifest?.providers?.[provider], field)
  if (privateCredential) return privateCredential

  const inlineProviders = provider === 'github'
    ? [manifest.providers?.github, manifest.providers?.githubActions]
    : [manifest.providers?.[provider]]
  for (const config of inlineProviders) {
    const credential = nestedStringValue(config, field)
    if (credential) return credential
  }

  return undefined
}

export function resolvePrivateValues({ manifest, repoRoot, env = process.env }) {
  const filePath = defaultPrivateValuesPath(repoRoot)
  const empty = {
    publicManifest: manifest,
    filePath,
    version: manifest.version,
    getEnvValue() {
      return undefined
    },
    getProviderCredential({ provider, field }) {
      return resolveProviderCredential({ manifest, env, provider, field })
    },
  }

  if (manifest.version !== 2 || !fs.existsSync(filePath)) return empty

  assertPrivateFileIsNotTracked({ repoRoot, filePath })
  assertPrivateFileMode(filePath)

  const privateManifest = asObject(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  assertPrivateDocumentFields(privateManifest)
  assertPrivateValuesVersion(privateManifest)
  assertAllowedPrivateProviderFields(privateManifest)
  if (privateManifest.env !== undefined && !isObject(privateManifest.env)) {
    throw new Error('private.json env must be an object.')
  }
  const privateEnv = asObject(privateManifest.env)
  const knownSources = new Set(configuredEnvMetadataSourceKeys(manifest))
  for (const sourceKey of Object.keys(privateEnv)) {
    if (!isObject(privateEnv[sourceKey])) {
      throw new Error(`private.json env.${sourceKey} must be an object.`)
    }
    if (!knownSources.has(sourceKey)) {
      throw new Error(`private.json env.${sourceKey} references unknown source.`)
    }

    const metadata = loadEnvMetadata({ baseDir: sourceKey, manifest, sourceKey })
    for (const key of Object.keys(asObject(privateEnv[sourceKey]))) {
      if (!isObject(privateEnv[sourceKey][key])) {
        throw new Error(`private.json env.${sourceKey}.${key} must be an object.`)
      }
      const entry = metadata.entries.get(key)
      if (!entry) {
        throw new Error(`private.json env.${sourceKey}.${key} references unknown variable.`)
      }
      if (!entry.encrypted) {
        throw new Error(`private.json env.${sourceKey}.${key} may only provide encrypted variables.`)
      }

      for (const [environment, value] of Object.entries(privateEnv[sourceKey][key])) {
        if (!manifest.environments.includes(environment)) {
          throw new Error(
            `private.json env.${sourceKey}.${key}.${environment} references unknown environment.`,
          )
        }
        if (typeof value !== 'string') {
          throw new Error(`private.json env.${sourceKey}.${key}.${environment} must be a string.`)
        }
      }
    }
  }

  return {
    ...empty,
    getEnvValue({ sourceKey, key, environment }) {
      const value = privateEnv?.[sourceKey]?.[key]?.[environment]
      return typeof value === 'string' ? value : undefined
    },
    getProviderCredential({ provider, field }) {
      return resolveProviderCredential({ manifest, privateManifest, env, provider, field })
    },
  }
}
