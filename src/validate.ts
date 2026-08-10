#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { resolvePlatformContext } from './core/context.js'
import {
  assertBrowserProjectionAllowed,
  effectiveEnvMetadataSourceKeys,
  isAllowedInEnv,
  loadEnvMetadata,
} from './core/env-metadata.js'
import { environmentOutputFile } from './core/env-files.js'
import { envSourceDir } from './core/env-source.js'
import { readManifest } from './core/manifest.js'
import { resolvePrivateValues } from './core/private-values.js'

function asObject(value: any): any {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizePackage(item) {
  if (typeof item === 'string' && item.trim()) {
    return { key: item.trim(), rootDirectory: item.trim() }
  }
  const config = asObject(item)
  const key = config.key || config.name
  if (typeof key !== 'string' || !key.trim()) return null
  return {
    ...config,
    key: key.trim(),
    rootDirectory: config.directory || config.dir || config.path || config.rootDirectory,
  }
}

function configuredPackages(manifest) {
  const configured = Array.isArray(manifest.packages) && manifest.packages.length > 0
    ? manifest.packages
    : Array.isArray(manifest.env?.packages)
      ? manifest.env.packages
      : manifest.apps
  return (configured || []).map(normalizePackage).filter(Boolean)
}

function outputPackages(manifest) {
  const packages = configuredPackages(manifest)
  const selected = manifest.env?.sync?.packages || manifest.env?.sync?.apps
  if (!Array.isArray(selected) || selected.length === 0) return packages
  const selectedKeys = new Set(selected)
  return packages.filter((item) => selectedKeys.has(item.key))
}

function outputDirectory(rootDir, item) {
  const configured = item.env?.outputDir || item.outputDir || item.rootDirectory
  if (typeof configured !== 'string' || !configured.trim()) return ''
  return path.isAbsolute(configured) ? configured : path.join(rootDir, configured)
}

function packageSourceKey(item) {
  return item.env?.sourceKey || item.sourceKey || item.key
}

function directOutputs(manifest, sourceRoot, sourceKeys) {
  if (manifest.env?.sync?.directOutputs === true) return true
  return sourceKeys.some((sourceKey) => {
    const metadata = loadEnvMetadata({ baseDir: path.join(sourceRoot, sourceKey), sourceKey, manifest })
    return [...metadata.entries.values()].some((entry) => entry.packages.length > 0)
  })
}

function configuredValueFor(entry, environment, { privateValues, sourceKey }: any = {}) {
  if (privateValues?.version === 2 && entry.encrypted) {
    return privateValues.getEnvValue({ sourceKey, key: entry.key, environment }) !== undefined
  }

  return entry.value !== undefined
    || Object.hasOwn(entry.values, 'default')
    || Object.hasOwn(entry.values, environment)
}

function isGitWorktree(rootDir) {
  const result = spawnSync('git', ['-C', rootDir, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  })
  return result.status === 0 && result.stdout.trim() === 'true'
}

function isInside(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function isGitIgnored(rootDir, target) {
  const relative = path.relative(rootDir, target)
  return spawnSync('git', ['-C', rootDir, 'check-ignore', '--quiet', '--', relative]).status === 0
}

export function validateEnvironmentRouting({ manifest, rootDir, privateValues }: any) {
  const errors: string[] = []
  const warnings: string[] = []
  const resolvedPrivateValues = privateValues || resolvePrivateValues({ manifest, repoRoot: rootDir })
  const sourceRoot = path.join(rootDir, envSourceDir(manifest))
  const routedPackages = outputPackages(manifest)
  const sourceKeys = effectiveEnvMetadataSourceKeys(manifest, {
    packageSourceKeys: routedPackages.map(packageSourceKey),
  })
  const usesDirectOutputs = directOutputs(manifest, sourceRoot, sourceKeys)
  if (!usesDirectOutputs) return { errors, warnings }

  if (manifest.env?.sync?.patchVariantsFromExample === true) {
    warnings.push('env.sync.patchVariantsFromExample is ignored when directOutputs is active.')
  }

  const packages = new Map<string, any>(configuredPackages(manifest).map((item) => [item.key, item]))
  const outputPackageKeys = new Set(routedPackages.map((item) => item.key))
  const sharedKey = manifest.env?.sync?.sharedKey || manifest.env?.sharedKey || 'shared'
  const disallowSharedOverrides = manifest.env?.sync?.disallowSharedOverrides === true
    || manifest.env?.sync?.forbidSharedOverrides === true
  const collisions = new Map<string, Set<string>>()
  const encryptedTargets = new Set<string>()

  for (const sourceKey of sourceKeys) {
    const metadata = loadEnvMetadata({
      baseDir: path.join(sourceRoot, sourceKey),
      sourceKey,
      manifest,
    })
    for (const entry of metadata.entries.values() as any) {
      for (const packageRef of entry.packages) {
        const packageConfig = packages.get(packageRef.package)
        if (!packageConfig) {
          errors.push(`${metadata.label} metadata for ${entry.key} routes to unknown package "${packageRef.package}".`)
          continue
        }
        if (!outputPackageKeys.has(packageConfig.key)) {
          errors.push(`${metadata.label} metadata for ${entry.key} routes to package "${packageConfig.key}", which is not enabled for env.sync output.`)
        }
        const directory = outputDirectory(rootDir, packageConfig)
        if (!directory) {
          errors.push(`Package "${packageConfig.key}" needs directory, rootDirectory, outputDir, or env.outputDir for env output.`)
          continue
        }

        const outputKey = packageRef.key || entry.key
        try {
          assertBrowserProjectionAllowed({
            entries: [{ ...entry, key: outputKey, metadata: entry }],
            prefix: '',
            metadataPath: metadata.label,
          })
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }

        if (disallowSharedOverrides) {
          const collisionKey = `${packageConfig.key}:${outputKey}`
          if (!collisions.has(collisionKey)) collisions.set(collisionKey, new Set())
          collisions.get(collisionKey)?.add(sourceKey)
        }

        for (const environment of manifest.environments) {
          if (!isAllowedInEnv(entry, environment)) continue
          if (!configuredValueFor(entry, environment, {
            privateValues: resolvedPrivateValues,
            sourceKey,
          })) {
            errors.push(
              `${metadata.label} metadata for ${entry.key} routed to ${packageConfig.key} must define value, values.default, or values.${environment}.`,
            )
          }
          if (entry.encrypted) {
            encryptedTargets.add(path.join(directory, environmentOutputFile(manifest, environment)))
          }
        }
      }
    }
  }

  if (disallowSharedOverrides) {
    for (const [key, sources] of collisions) {
      if (sources.size > 1 && sources.has(sharedKey)) {
        errors.push(`Shared/output collision for ${key}: ${[...sources].join(', ')}. Remove the app-specific duplicate or disable disallowSharedOverrides.`)
      }
    }
  }

  if (isGitWorktree(rootDir)) {
    for (const target of encryptedTargets) {
      if (isInside(rootDir, target) && !isGitIgnored(rootDir, target)) {
        errors.push(`Encrypted env target is not Git-ignored: ${path.relative(rootDir, target)}.`)
      }
    }
  }

  return { errors, warnings }
}

async function main() {
  const context = resolvePlatformContext(process.argv.slice(2))
  const manifest = readManifest(context.manifestPath)
  const { errors, warnings } = validateEnvironmentRouting({ manifest, rootDir: context.repoRoot })
  for (const warning of warnings) console.error(`Warning: ${warning}`)
  if (errors.length > 0) {
    for (const error of errors) console.error(`Error: ${error}`)
    process.exitCode = 1
    return
  }
  console.log('Validation passed.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('Error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
