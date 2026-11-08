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
  return path.join(repoRoot, '.iac', 'private.json')
}

function assertPrivateValuesVersion(privateManifest) {
  if (privateManifest.version !== 1) {
    throw new Error('private.json version must be 1.')
  }
}

function assertPrivateDocumentFields(privateManifest) {
  const allowed = new Set(['version', 'env', 'credentials'])
  for (const key of Object.keys(privateManifest)) {
    if (!allowed.has(key)) throw new Error(`private.json ${key} is not allowed.`)
  }
}

function validatePrivateCredentials(privateManifest, manifest) {
  if (privateManifest.credentials !== undefined && !isObject(privateManifest.credentials)) {
    throw new Error('private.json credentials must be an object.')
  }
  const credentials = asObject(privateManifest.credentials)
  for (const [id, values] of Object.entries(credentials)) {
    const declaration = manifest.credentials?.[id]
    if (!declaration) throw new Error(`private.json credentials.${id} references unknown credential.`)
    if (!isObject(values)) throw new Error(`private.json credentials.${id} must be an object.`)
    for (const [environment, value] of Object.entries(values)) {
      if (!declaration.environments.includes(environment)) {
        throw new Error(
          `private.json credentials.${id}.${environment} references an undeclared environment.`,
        )
      }
      if (typeof value !== 'string') {
        throw new Error(`private.json credentials.${id}.${environment} must be a string.`)
      }
    }
  }
  return credentials
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
      : provider === 'digitalocean' && field === 'token'
        ? ['DIGITALOCEAN_TOKEN']
        : provider === 'cloudflare' && field === 'apiToken'
          ? ['CLOUDFLARE_API_TOKEN']
      : []

  for (const name of names) {
    const value = env?.[name]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function resolveProviderCredential({ manifest, env, provider, field }: any) {
  const processCredential = processProviderCredential(env, provider, field)
  if (processCredential) return processCredential

  const inlineProviders = provider === 'github'
    ? [manifest.providers?.github, manifest.providers?.githubActions]
    : [manifest.providers?.[provider]]
  for (const config of inlineProviders) {
    const credential = nestedStringValue(config, field)
    if (credential) return credential
  }

  return undefined
}

function localExampleValue({ environment, example }) {
  return environment === 'local' && typeof example === 'string' ? example : undefined
}

function declaredCredential(manifest, { id, environment }) {
  const declaration = manifest.credentials?.[id]
  if (!declaration) throw new Error(`Credential ${id} is not declared in iac.json.`)
  if (!declaration.environments.includes(environment)) {
    throw new Error(`Credential ${id} is not declared for ${environment}.`)
  }
  return declaration
}

export function resolvePrivateValues({ manifest, repoRoot, env = process.env }) {
  const referencedPrivateValues = env?.VERTILE_IAC_PRIVATE_VALUES
  const filePath = typeof referencedPrivateValues === 'string' && referencedPrivateValues.trim()
    ? path.resolve(referencedPrivateValues)
    : defaultPrivateValuesPath(repoRoot)
  const privateRepoRoot = filePath === defaultPrivateValuesPath(repoRoot)
    ? repoRoot
    : path.dirname(path.dirname(filePath))
  const empty = {
    publicManifest: manifest,
    filePath,
    version: manifest.version,
    getEnvValue(request) {
      return manifest.version === 2 ? localExampleValue(request) : undefined
    },
    getCredential(request) {
      declaredCredential(manifest, request)
      return undefined
    },
    getProviderCredential({ provider, field }) {
      return resolveProviderCredential({ manifest, env, provider, field })
    },
  }

  if (manifest.version !== 2 || !fs.existsSync(filePath)) return empty

  assertPrivateFileIsNotTracked({ repoRoot: privateRepoRoot, filePath })
  assertPrivateFileMode(filePath)

  const privateManifest = asObject(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  assertPrivateDocumentFields(privateManifest)
  assertPrivateValuesVersion(privateManifest)
  const privateCredentials = validatePrivateCredentials(privateManifest, manifest)
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
    getEnvValue({ sourceKey, key, environment, example }) {
      const value = privateEnv?.[sourceKey]?.[key]?.[environment]
      return typeof value === 'string'
        ? value
        : localExampleValue({ environment, example })
    },
    getCredential({ id, environment }) {
      declaredCredential(manifest, { id, environment })
      const value = privateCredentials?.[id]?.[environment]
      return typeof value === 'string' && value.trim() ? value : undefined
    },
    getProviderCredential({ provider, field }) {
      return resolveProviderCredential({ manifest, env, provider, field })
    },
  }
}
