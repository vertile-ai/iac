#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { resolvePlatformContext } from './core/context.mjs'
import { readManifest } from './core/manifest.mjs'
import { readOption } from './shared.mjs'

const defaultVariants = {
  local: { output: '.env.local', sources: ['.env.local'] },
  production: { output: '.env.production', sources: ['.env.production'], strict: true },
  staging: { output: '.env.staging', sources: ['.env.staging'], strict: true },
  preview: { output: '.env.staging', sources: ['.env.staging'], strict: true },
  test: { output: '.env.test', sources: ['.env.test'] },
}

function hasFlag(argv, flag) {
  return argv.includes(flag)
}

function splitList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function selectedVariantNames(argv) {
  const value = readOption(argv, '--variants')
  if (!value) return ['local', 'production', 'staging', 'test']

  const names = splitList(value)
  const invalid = names.filter((name) => !defaultVariants[name])
  if (invalid.length > 0) {
    throw new Error(
      `Invalid --variants values: ${invalid.join(', ')}. Supported: ${Object.keys(defaultVariants).join(',')}`,
    )
  }
  return names
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

function parseEnvLine(line) {
  if (!line) return null
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const eqIndex = line.indexOf('=')
  if (eqIndex <= 0) return null

  const key = line.slice(0, eqIndex).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null

  return { key, value: line.slice(eqIndex + 1) }
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(parseEnvLine).filter(Boolean)
}

function mergeLayers(layers) {
  const order = []
  const values = new Map()

  for (const layer of layers) {
    for (const { key, value } of layer) {
      if (!values.has(key)) order.push(key)
      values.set(key, value)
    }
  }

  return order.map((key) => ({ key, value: values.get(key) }))
}

function entriesToLines(entries) {
  return entries.map(({ key, value }) => `${key}=${value}`)
}

function resolveLayer({ rootDir, baseDir, variant }) {
  const examplePath = path.join(baseDir, '.env.example')
  const sourcePath = path.join(baseDir, variant.sources[0])

  if (variant.strict) {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `Missing required infrastructure env source file: ${path.relative(rootDir, sourcePath)}`,
      )
    }
    return {
      entries: readEnvFile(sourcePath),
      sourceLabel: path.relative(rootDir, sourcePath),
    }
  }

  if (!fs.existsSync(examplePath) && !fs.existsSync(sourcePath)) {
    throw new Error(
      `Missing required infrastructure env source files: ${path.relative(rootDir, sourcePath)} or ${path.relative(rootDir, examplePath)}`,
    )
  }

  const layers = []
  const labels = []
  if (fs.existsSync(examplePath)) {
    layers.push(readEnvFile(examplePath))
    labels.push(path.relative(rootDir, examplePath))
  }
  if (fs.existsSync(sourcePath)) {
    layers.push(readEnvFile(sourcePath))
    labels.push(path.relative(rootDir, sourcePath))
  }

  return {
    entries: mergeLayers(layers),
    sourceLabel: labels.join(' + '),
  }
}

function appSharedPrefix(app) {
  return app.env?.sharedPrefix || app.providers?.vercel?.env?.sharedPrefix || ''
}

function projectSharedLayer(sharedLayer, app, sharedPrefixes = []) {
  const prefix = appSharedPrefix(app)
  if (!prefix) {
    return sharedLayer.filter(
      ({ key }) => !sharedPrefixes.some((item) => key.startsWith(item)),
    )
  }

  return sharedLayer
    .filter(({ key }) => key.startsWith(prefix))
    .map(({ key, value }) => ({ key: key.slice(prefix.length), value }))
    .filter(({ key }) => key)
}

function assertNoSharedOverrides(sharedLayer, packageLayer, appKey) {
  const sharedKeys = new Set(sharedLayer.map(({ key }) => key))
  const overlaps = packageLayer
    .map(({ key }) => key)
    .filter((key, index, keys) => sharedKeys.has(key) && keys.indexOf(key) === index)

  if (overlaps.length === 0) return

  throw new Error(
    `Detected shared env key overrides for app "${appKey}": ${overlaps.join(', ')}`,
  )
}

function linesToEnvMap(lines) {
  const values = new Map()
  for (const line of lines) {
    const parsed = parseEnvLine(line)
    if (parsed) values.set(parsed.key, parsed.value)
  }
  return values
}

function diffEnvMaps(before, after) {
  const changes = []
  const orderedKeys = [...after.keys(), ...before.keys()]
  const seen = new Set()

  for (const key of orderedKeys) {
    if (seen.has(key)) continue
    seen.add(key)

    if (!before.has(key) && after.has(key)) changes.push({ type: 'added', key })
    else if (before.has(key) && !after.has(key)) changes.push({ type: 'removed', key })
    else if (before.get(key) !== after.get(key)) changes.push({ type: 'updated', key })
  }

  return changes
}

function syncApps(manifest) {
  const configured = manifest.env.sync?.apps
  if (Array.isArray(configured) && configured.length > 0) {
    const keys = new Set(configured)
    return manifest.apps.filter((app) => keys.has(app.key))
  }
  return manifest.apps
}

function appOutputDir(rootDir, app) {
  const configured = app.env?.outputDir || app.outputDir || app.rootDirectory
  if (!configured) {
    throw new Error(`Missing rootDirectory or env.outputDir for app "${app.key}"`)
  }
  return path.isAbsolute(configured) ? configured : path.join(rootDir, configured)
}

function appSourceKey(app) {
  return app.env?.sourceKey || app.sourceKey || app.key
}

function shouldSkipSync(manifest) {
  if (manifest.env.sync?.skipInVercel === false) return false
  return (
    process.env.SKIP_INFRA_ENV_SYNC === '1' ||
    process.env.VERCEL === '1' ||
    Boolean(process.env.VERCEL_ENV) ||
    Boolean(process.env.VERCEL_TARGET_ENV)
  )
}

async function main() {
  const argv = process.argv.slice(2)
  const context = resolvePlatformContext(argv)
  const manifest = readManifest(context.manifestPath)
  const dryRun = hasFlag(argv, '--dry-run')
  const variants = selectedVariantNames(argv).map((name) => ({
    name,
    ...defaultVariants[name],
  }))

  if (shouldSkipSync(manifest)) {
    console.log('Skipping infrastructure env sync; using provisioned environment variables.')
    return
  }

  const sourceRoot = path.join(context.repoRoot, envSourceDir(manifest))
  const sharedKey = manifest.env.sync?.sharedKey || manifest.env.sharedKey || 'shared'
  const apps = syncApps(manifest)
  const sharedPrefixes = apps.map(appSharedPrefix).filter(Boolean)

  for (const app of apps) {
    for (const variant of variants) {
      const shared = resolveLayer({
        rootDir: context.repoRoot,
        baseDir: path.join(sourceRoot, sharedKey),
        variant,
      })
      const scoped = resolveLayer({
        rootDir: context.repoRoot,
        baseDir: path.join(sourceRoot, appSourceKey(app)),
        variant,
      })

      const sharedEntries = projectSharedLayer(shared.entries, app, sharedPrefixes)
      assertNoSharedOverrides(sharedEntries, scoped.entries, app.key)

      const merged = mergeLayers([sharedEntries, scoped.entries])
      const mergedLines = entriesToLines(merged)
      const outputPath = path.join(appOutputDir(context.repoRoot, app), variant.output)
      const before = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
      const content = [
        '# AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.',
        `# Source: ${shared.sourceLabel} + ${scoped.sourceLabel}`,
        '',
        ...mergedLines,
        '',
      ].join('\n')

      if (before === content) continue

      const beforeEnv = linesToEnvMap(before.split(/\r?\n/))
      const afterEnv = linesToEnvMap(mergedLines)
      const changes = diffEnvMaps(beforeEnv, afterEnv)

      if (!dryRun) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })
        fs.writeFileSync(outputPath, content, 'utf8')
      }

      for (const change of changes) {
        const verb = dryRun
          ? change.type === 'added'
            ? 'Would add'
            : change.type === 'removed'
              ? 'Would remove'
              : 'Would update'
          : change.type === 'added'
            ? 'Added'
            : change.type === 'removed'
              ? 'Removed'
              : 'Updated'
        console.log(`${verb} ${path.relative(context.repoRoot, outputPath)} ${change.key}`)
      }
    }
  }
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
