#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { resolvePlatformContext } from './core/context.mjs'
import { envSourceDir } from './core/env-source.mjs'
import { environmentFiles, environmentOutputFile } from './core/env-files.mjs'
import {
  applyEnvMetadata,
  assertBrowserProjectionAllowed,
  isAllowedInEnv,
  loadEnvMetadata,
  manifestEnvEntries,
} from './core/env-metadata.mjs'
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

function configuredVariants(manifest) {
  const variants = { ...defaultVariants }
  const configured = manifest.environmentFiles || {}
  for (const [name, config] of Object.entries(configured)) {
    const strict = config && typeof config === 'object' && !Array.isArray(config)
      ? config.strict ?? true
      : true
    variants[name] = {
      output: environmentOutputFile(manifest, name),
      sources: environmentFiles(manifest, name),
      strict,
    }
  }
  return variants
}

function selectedVariantNames(argv, variants) {
  const value = readOption(argv, '--variants')
  if (!value) return ['local', 'production', 'staging', 'test']

  const names = splitList(value)
  const invalid = names.filter((name) => !variants[name])
  if (invalid.length > 0) {
    throw new Error(
      `Invalid --variants values: ${invalid.join(', ')}. Supported: ${Object.keys(variants).join(',')}`,
    )
  }
  return names
}

function parseEnvLine(line) {
  if (!line) return null
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const eqIndex = line.indexOf('=')
  if (eqIndex <= 0) return null

  const key = line.slice(0, eqIndex).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null

  return { key, value: parseEnvValue(line.slice(eqIndex + 1)) }
}

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim()
  if (trimmed.length < 2) return rawValue

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === 'string' ? parsed : rawValue
    } catch {
      return rawValue
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }

  return rawValue
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(parseEnvLine).filter(Boolean)
}

function mergeLayers(layers) {
  const order = []
  const values = new Map()

  for (const layer of layers) {
    for (const entry of layer) {
      const { key, value } = entry
      if (!values.has(key)) order.push(key)
      values.set(key, { ...entry, value })
    }
  }

  return order.map((key) => values.get(key))
}

function entriesToLines(entries) {
  return entries.map(({ key, value }) => `${key}=${JSON.stringify(String(value))}`)
}

function ensureTrailingNewline(content) {
  if (!content) return ''
  return content.endsWith('\n') ? content : `${content}\n`
}

function filterEntriesForVariant(entries, metadata, variantName) {
  if (!metadata.required) return entries
  return entries.filter((entry) => {
    const config = metadata.entries.get(entry.key)
    return !config || isAllowedInEnv(config, variantName)
  })
}

function metadataDisplayPath(metadata, rootDir) {
  return path.isAbsolute(metadata.filePath)
    ? path.relative(rootDir, metadata.filePath)
    : metadata.label || metadata.filePath
}

function patchVariantFromExample({ rootDir, baseDir, sourceKey, variant, manifest, dryRun }) {
  const examplePath = path.join(baseDir, '.env.example')
  const variantPath = path.join(baseDir, variant.output)
  if (!fs.existsSync(examplePath)) return []

  const metadata = loadEnvMetadata({ baseDir, manifest, sourceKey })
  const exampleEntries = filterEntriesForVariant(
    readEnvFile(examplePath),
    metadata,
    variant.name,
  )
  const patches = []
  if (exampleEntries.length === 0) return patches

  if (!fs.existsSync(variantPath)) {
    const content = `${entriesToLines(exampleEntries).join('\n')}\n`
    if (!dryRun) fs.writeFileSync(variantPath, content, 'utf8')
    return exampleEntries.map((entry) => ({
      envFile: path.relative(rootDir, variantPath),
      key: entry.key,
      action: 'created-from-example',
    }))
  }

  const currentContent = fs.readFileSync(variantPath, 'utf8')
  const currentEntries = readEnvFile(variantPath)
  const currentKeys = new Set(currentEntries.map(({ key }) => key))
  const missingEntries = exampleEntries.filter(({ key }) => !currentKeys.has(key))
  if (missingEntries.length === 0) return patches

  const appendix = [
    '',
    '# Added by env:sync from .env.example',
    ...entriesToLines(missingEntries),
    '',
  ].join('\n')
  if (!dryRun) {
    fs.writeFileSync(
      variantPath,
      `${ensureTrailingNewline(currentContent)}${appendix}`,
      'utf8',
    )
  }

  return missingEntries.map((entry) => ({
    envFile: path.relative(rootDir, variantPath),
    key: entry.key,
    action: 'patched-missing-key',
  }))
}

function reconcileVariantWithMetadata({ rootDir, baseDir, sourceKey, variant, manifest, dryRun }) {
  const variantPath = path.join(baseDir, variant.output)
  if (!fs.existsSync(variantPath)) return []

  const metadata = loadEnvMetadata({ baseDir, manifest, sourceKey })
  if (!metadata.required) {
    console.warn(
      `Skipping reconcile-delete for ${path.relative(rootDir, variantPath)}; missing ${path.relative(rootDir, metadata.filePath)}`,
    )
    return []
  }

  const metadataEntries = [...metadata.entries.values()].filter((entry) =>
    isAllowedInEnv(entry, variant.name)
  )
  const metadataKeys = new Set(metadataEntries.map(({ key }) => key))
  const currentEntries = readEnvFile(variantPath)
  const currentMap = new Map(currentEntries.map(({ key, value }) => [key, value]))
  const staleEntries = currentEntries.filter(({ key }) => !metadataKeys.has(key))
  const missingEntries = metadataEntries.filter(({ key }) => !currentMap.has(key))
  if (staleEntries.length === 0 && missingEntries.length === 0) return []

  const reconciledEntries = metadataEntries.map(({ key, example }) => ({
    key,
    value: currentMap.has(key) ? currentMap.get(key) : example,
  }))
  const reconciledContent = `${entriesToLines(reconciledEntries).join('\n')}\n`
  if (!dryRun) fs.writeFileSync(variantPath, reconciledContent, 'utf8')

  return [
    ...staleEntries.map(({ key }) => ({
      envFile: path.relative(rootDir, variantPath),
      key,
      action: 'removed-stale-key',
    })),
    ...missingEntries.map(({ key }) => ({
      envFile: path.relative(rootDir, variantPath),
      key,
      action: 'added-from-metadata',
    })),
  ]
}

function writeEnvExampleFromMetadata({ rootDir, baseDir, sourceKey, manifest, dryRun }) {
  const metadata = loadEnvMetadata({ baseDir, manifest, sourceKey })
  if (!metadata.required) return null

  const entries = [...metadata.entries.values()]
    .filter((entry) => entry.includeInExample !== false)
    .map(({ key, example }) => ({ key, value: example }))
  if (entries.length === 0) return null

  const outputPath = path.join(baseDir, '.env.example')
  const before = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
  const content = [
    '# AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.',
    `# Source: ${metadataDisplayPath(metadata, rootDir)}`,
    '',
    ...entriesToLines(entries),
    '',
  ].join('\n')

  if (before === content) return null
  if (!dryRun) fs.writeFileSync(outputPath, content, 'utf8')

  return path.relative(rootDir, outputPath)
}

function configuredMetadataSourceKeys(manifest) {
  const configured = manifest.env?.metadata || manifest.env?.envJson
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return []

  const keys = []
  for (const key of Object.keys(configured)) {
    if (key !== 'sources') keys.push(key)
  }
  const sources = configured.sources
  if (sources && typeof sources === 'object' && !Array.isArray(sources)) {
    keys.push(...Object.keys(sources))
  }
  return [...new Set(keys)]
}

function usesDirectOutputs(manifest) {
  const sync = manifest.env?.sync || {}
  if (sync.directOutputs === true) {
    return true
  }

  for (const sourceKey of configuredMetadataSourceKeys(manifest)) {
    const metadata = loadEnvMetadata({ baseDir: sourceKey, sourceKey, manifest })
    if ([...metadata.entries.values()].some((entry) => entry.packages.length > 0)) return true
  }
  return false
}

function packageRefForPackage(entry, packageConfig) {
  return entry.packages.find((packageRef) => packageRef.package === packageConfig.key)
}

function valueForMetadataEntry({ entry, environment, metadata }) {
  if (!entry.valuesConfigured) return undefined

  const hasEnvironmentValue = Object.hasOwn(entry.values, environment)
  const hasDefaultValue = Object.hasOwn(entry.values, 'default')
  const hasValue = entry.value !== undefined
  if (!hasEnvironmentValue && !hasDefaultValue && !hasValue) {
    throw new Error(
      `${metadataDisplayPath(metadata, process.cwd())} metadata for ${entry.key} must define value, values.default, or values.${environment}.`,
    )
  }

  return hasEnvironmentValue
    ? entry.values[environment]
    : hasDefaultValue
      ? entry.values.default
      : entry.value
}

function directOutputEntriesForApp({
  rootDir,
  sourceRoot,
  sourceKeys,
  app,
  variant,
  manifest,
  example = false,
}) {
  const layers = []
  const sourceLabels = []

  for (const sourceKey of sourceKeys) {
    const baseDir = path.join(sourceRoot, sourceKey)
    const metadata = loadEnvMetadata({ baseDir, sourceKey, manifest })
    if (!metadata.required) continue

    const entries = []
    for (const entry of metadata.entries.values()) {
      const packageRef = packageRefForPackage(entry, app)
      if (!packageRef) continue
      if (!example && !isAllowedInEnv(entry, variant.name)) continue
      if (example && entry.includeInExample === false) continue

      const outputKey = packageRef.key || entry.key
      const outputEntry = {
        ...entry,
        key: outputKey,
        value: example
          ? entry.example
          : valueForMetadataEntry({ entry, environment: variant.name, metadata }),
        metadata: entry,
      }
      if (!example && outputEntry.value === undefined) continue

      assertBrowserProjectionAllowed({
        entries: [outputEntry],
        prefix: '',
        metadataPath: metadataDisplayPath(metadata, rootDir),
      })
      entries.push(outputEntry)
    }

    if (entries.length > 0) {
      layers.push(entries)
      sourceLabels.push(
        example
          ? `${metadataDisplayPath(metadata, rootDir)} example`
          : `${metadataDisplayPath(metadata, rootDir)} values.${variant.name}`,
      )
    }
  }

  return {
    entries: mergeLayers(layers),
    sourceLabel: sourceLabels.join(' + '),
  }
}

function appExampleOutputPath(rootDir, app) {
  const configured =
    app.env?.examplePath ||
    app.env?.exampleOutput ||
    app.examplePath ||
    app.exampleOutput
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(rootDir, configured)
  }
  return path.join(appOutputDir(rootDir, app), '.env.example')
}

function manifestLayerForVariant({ baseDir, sourceKey, variant, manifest }) {
  return manifestEnvEntries({
    baseDir,
    manifest,
    sourceKey,
    environment: variant.name,
  })
}

function writeManifestValuesForVariant({ rootDir, baseDir, sourceKey, variant, manifest, dryRun }) {
  const manifestLayer = manifestLayerForVariant({ baseDir, sourceKey, variant, manifest })
  if (!manifestLayer) return { handled: false, patches: [] }

  const outputPath = path.join(baseDir, variant.output)
  if (manifestLayer.entries.length === 0) {
    if (!fs.existsSync(outputPath)) return { handled: true, patches: [] }

    const before = fs.readFileSync(outputPath, 'utf8')
    const beforeEnv = linesToEnvMap(before.split(/\r?\n/))
    if (!dryRun) fs.rmSync(outputPath, { force: true })
    return {
      handled: true,
      patches: [...beforeEnv.keys()].map((key) => ({
        envFile: path.relative(rootDir, outputPath),
        key,
        action: 'manifest-values-removed',
      })),
    }
  }

  const content = `${entriesToLines(manifestLayer.entries).join('\n')}\n`
  const before = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
  if (before === content) return { handled: true, patches: [] }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, content, 'utf8')
  }

  const beforeEnv = linesToEnvMap(before.split(/\r?\n/))
  const afterEnv = linesToEnvMap(content.split(/\r?\n/))
  const patches = diffEnvMaps(beforeEnv, afterEnv).map((change) => ({
    envFile: path.relative(rootDir, outputPath),
    key: change.key,
    action: `manifest-values-${change.type}`,
  }))

  return { handled: true, patches }
}

function resolveLayer({ rootDir, baseDir, sourceKey, variant, manifest }) {
  const examplePath = path.join(baseDir, '.env.example')
  const sourcePaths = variant.sources.map((source) => path.join(baseDir, source))
  const existingSourcePaths = sourcePaths.filter((sourcePath) => fs.existsSync(sourcePath))
  const metadata = loadEnvMetadata({ baseDir, manifest, sourceKey })
  const manifestLayer = manifestLayerForVariant({ baseDir, sourceKey, variant, manifest })
  if (manifestLayer) {
    return {
      entries: manifestLayer.entries,
      metadataPath: metadataDisplayPath(metadata, rootDir),
      sourceLabel: manifestLayer.sourceLabel,
    }
  }

  if (variant.strict) {
    if (existingSourcePaths.length === 0) {
      throw new Error(
        `Missing required env source file: ${sourcePaths.map((sourcePath) => path.relative(rootDir, sourcePath)).join(' or ')}`,
      )
    }
    const entries = filterEntriesForVariant(
      mergeLayers(existingSourcePaths.map(readEnvFile)),
      metadata,
      variant.name,
    )
    return {
      entries: applyEnvMetadata({ baseDir, entries, manifest, sourceKey }),
      metadataPath: metadataDisplayPath(metadata, rootDir),
      sourceLabel: existingSourcePaths.map((sourcePath) => path.relative(rootDir, sourcePath)).join(' + '),
    }
  }

  if (!fs.existsSync(examplePath) && existingSourcePaths.length === 0) {
    throw new Error(
      `Missing required env source files: ${sourcePaths.map((sourcePath) => path.relative(rootDir, sourcePath)).join(' or ')} or ${path.relative(rootDir, examplePath)}`,
    )
  }

  const layers = []
  const labels = []
  if (fs.existsSync(examplePath)) {
    layers.push(readEnvFile(examplePath))
    labels.push(path.relative(rootDir, examplePath))
  }
  for (const sourcePath of existingSourcePaths) {
    layers.push(readEnvFile(sourcePath))
    labels.push(path.relative(rootDir, sourcePath))
  }

  const entries = filterEntriesForVariant(mergeLayers(layers), metadata, variant.name)
  return {
    entries: applyEnvMetadata({ baseDir, entries, manifest, sourceKey }),
    metadataPath: metadataDisplayPath(metadata, rootDir),
    sourceLabel: labels.join(' + '),
  }
}

function appSharedPrefix(app) {
  return app.env?.sharedPrefix || app.providers?.vercel?.env?.sharedPrefix || ''
}

function projectSharedLayer(sharedLayer, app, sharedPrefixes = [], metadataPath = '.env.json') {
  const prefix = appSharedPrefix(app)
  if (!prefix) {
    return sharedLayer.filter(
      ({ key }) => !sharedPrefixes.some((item) => key.startsWith(item)),
    )
  }

  const projectedEntries = sharedLayer.filter(({ key }) => key.startsWith(prefix))
  assertBrowserProjectionAllowed({
    entries: projectedEntries,
    prefix,
    metadataPath,
  })

  return projectedEntries
    .map(({ key, value, metadata, encrypted, browser, includeInExample }) => ({
      key: key.slice(prefix.length),
      value,
      metadata,
      encrypted,
      browser,
      includeInExample,
    }))
    .filter(({ key }) => key)
}

function requiredSharedAliases(manifest) {
  const configured = manifest.env?.sync?.requiredSharedAliases
  return Array.isArray(configured) ? configured : []
}

function assertRequiredSharedAliases({ sharedLayer, projectedLayer, app, requiredAliases }) {
  const prefix = appSharedPrefix(app)
  if (!prefix || requiredAliases.length === 0) return

  const sharedKeys = new Set(sharedLayer.map(({ key }) => key))
  const sharedValues = new Map(sharedLayer.map(({ key, value }) => [key, value]))
  const projectedKeys = new Set(projectedLayer.map(({ key }) => key))
  const missingAliases = []
  const missingProjectedKeys = []
  const mismatchedAliasValues = []

  for (const canonicalKey of requiredAliases) {
    if (!sharedKeys.has(canonicalKey)) continue

    const aliasKey = `${prefix}${canonicalKey}`
    if (!sharedKeys.has(aliasKey)) missingAliases.push(aliasKey)
    if (!projectedKeys.has(canonicalKey)) missingProjectedKeys.push(canonicalKey)
    if (
      sharedKeys.has(aliasKey) &&
      sharedValues.get(aliasKey) !== sharedValues.get(canonicalKey)
    ) {
      mismatchedAliasValues.push(`${aliasKey}!=${canonicalKey}`)
    }
  }

  if (
    missingAliases.length === 0 &&
    missingProjectedKeys.length === 0 &&
    mismatchedAliasValues.length === 0
  ) {
    return
  }

  const details = []
  if (missingAliases.length > 0) {
    details.push(`missing aliases in shared env source: ${missingAliases.join(', ')}`)
  }
  if (missingProjectedKeys.length > 0) {
    details.push(
      `missing projected app keys after alias mapping: ${missingProjectedKeys.join(', ')}`,
    )
  }
  if (mismatchedAliasValues.length > 0) {
    details.push(
      `alias values must match canonical shared keys: ${mismatchedAliasValues.join(', ')}`,
    )
  }

  throw new Error(
    `shared prefix projection parity failed for app "${app.key}": ${details.join('; ')}`,
  )
}

function assertNoSharedOverrides({ sharedLayer, scopedLayer, app }) {
  const sharedKeys = new Set(sharedLayer.map(({ key }) => key))
  const overlappingKeys = scopedLayer
    .map(({ key }) => key)
    .filter((key, index, arr) => sharedKeys.has(key) && arr.indexOf(key) === index)

  if (overlappingKeys.length === 0) return

  const guidance = appSharedPrefix(app)
    ? `For app-specific shared values, define ${appSharedPrefix(app)}<KEY> in the shared env source.`
    : 'Define shared keys only in the shared env source.'

  throw new Error(
    [
      `Detected shared env key overrides for app "${app.key}": ${overlappingKeys.join(', ')}`,
      guidance,
      `Remove duplicate keys from the "${appSourceKey(app)}" env source.`,
    ].join(' '),
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

function normalizePackageConfig(item) {
  if (typeof item === 'string' && item.trim()) {
    return { key: item.trim(), name: item.trim(), rootDirectory: item.trim() }
  }

  const config = item && typeof item === 'object' && !Array.isArray(item) ? item : null
  if (!config) return null

  const key = config.key || config.name
  if (typeof key !== 'string' || key.trim() === '') return null

  return {
    ...config,
    key: key.trim(),
    name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : key.trim(),
    rootDirectory: config.directory || config.dir || config.path || config.rootDirectory,
  }
}

function manifestPackages(manifest) {
  const configured = Array.isArray(manifest.packages)
    ? manifest.packages
    : Array.isArray(manifest.env?.packages)
      ? manifest.env.packages
      : manifest.apps
  return (configured || []).map(normalizePackageConfig).filter(Boolean)
}

function syncPackages(manifest) {
  const configured = manifest.env?.sync?.packages || manifest.env?.sync?.apps
  const packages = manifestPackages(manifest)
  if (Array.isArray(configured) && configured.length > 0) {
    const keys = new Set(configured)
    return packages.filter((packageConfig) => keys.has(packageConfig.key))
  }
  return packages
}

function appOutputDir(rootDir, app) {
  const configured = app.env?.outputDir || app.outputDir || app.rootDirectory
  if (!configured) {
    throw new Error(`Missing directory, rootDirectory, or env.outputDir for package "${app.key}"`)
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
  const writeExamples = hasFlag(argv, '--write-examples') || hasFlag(argv, '--export-examples')
  const reconcileDelete = hasFlag(argv, '--reconcile-delete')
  const availableVariants = configuredVariants(manifest)
  const variants = selectedVariantNames(argv, availableVariants).map((name) => ({
    name,
    ...availableVariants[name],
  }))

  if (shouldSkipSync(manifest)) {
    console.log('Skipping infrastructure env sync; using provisioned environment variables.')
    return
  }

  const sourceRoot = path.join(context.repoRoot, envSourceDir(manifest))
  const sharedKey = manifest.env.sync?.sharedKey || manifest.env.sharedKey || 'shared'
  const apps = syncPackages(manifest)
  const sharedPrefixes = apps.map(appSharedPrefix).filter(Boolean)
  const sourceKeys = new Set([
    sharedKey,
    ...apps.map(appSourceKey),
    ...configuredMetadataSourceKeys(manifest),
  ])
  const directOutputs = usesDirectOutputs(manifest)
  const shouldPatchVariants =
    hasFlag(argv, '--patch-variants-from-example') ||
    manifest.env?.sync?.patchVariantsFromExample === true
  const shouldDisallowSharedOverrides =
    manifest.env?.sync?.disallowSharedOverrides === true ||
    manifest.env?.sync?.forbidSharedOverrides === true
  const sharedAliases = requiredSharedAliases(manifest)

  if (writeExamples && directOutputs) {
    for (const app of apps) {
      const result = directOutputEntriesForApp({
        rootDir: context.repoRoot,
        sourceRoot,
        sourceKeys,
        app,
        variant: { name: 'example' },
        manifest,
        example: true,
      })
      if (result.entries.length === 0) continue

      const outputPath = appExampleOutputPath(context.repoRoot, app)
      const content = [
        '# AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.',
        `# Source: ${result.sourceLabel}`,
        '',
        ...entriesToLines(result.entries),
        '',
      ].join('\n')
      const before = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
      if (before === content) continue
      if (!dryRun) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true })
        fs.writeFileSync(outputPath, content, 'utf8')
      }
      console.log(`${dryRun ? 'Would write' : 'Wrote'} ${path.relative(context.repoRoot, outputPath)}`)
    }
  } else if (writeExamples) {
    for (const sourceKey of sourceKeys) {
      const writtenPath = writeEnvExampleFromMetadata({
        rootDir: context.repoRoot,
        baseDir: path.join(sourceRoot, sourceKey),
        sourceKey,
        manifest,
        dryRun,
      })
      if (writtenPath) {
        console.log(`${dryRun ? 'Would write' : 'Wrote'} ${writtenPath}`)
      }
    }
  }

  const variantPatches = []
  const manifestValueVariants = new Set()
  if (!directOutputs) {
    for (const sourceKey of sourceKeys) {
      const baseDir = path.join(sourceRoot, sourceKey)
      for (const variant of variants) {
        const result = writeManifestValuesForVariant({
          rootDir: context.repoRoot,
          baseDir,
          sourceKey,
          variant,
          manifest,
          dryRun,
        })
        if (result.handled) {
          manifestValueVariants.add(`${sourceKey}:${variant.name}`)
          variantPatches.push(...result.patches)
        }
      }
    }
  }

  if (!directOutputs && (shouldPatchVariants || reconcileDelete)) {
    for (const sourceKey of sourceKeys) {
      const baseDir = path.join(sourceRoot, sourceKey)
      for (const variant of variants) {
        if (manifestValueVariants.has(`${sourceKey}:${variant.name}`)) continue
        if (shouldPatchVariants) {
          variantPatches.push(...patchVariantFromExample({
            rootDir: context.repoRoot,
            baseDir,
            sourceKey,
            variant,
            manifest,
            dryRun,
          }))
        }
        if (reconcileDelete) {
          variantPatches.push(...reconcileVariantWithMetadata({
            rootDir: context.repoRoot,
            baseDir,
            sourceKey,
            variant,
            manifest,
            dryRun,
          }))
        }
      }
    }
  }

  for (const patch of variantPatches) {
    const verb = dryRun ? 'Would patch' : 'Patched'
    console.log(`${verb} ${patch.envFile} ${patch.key} (${patch.action})`)
  }

  for (const app of apps) {
    for (const variant of variants) {
      if (directOutputs) {
        const result = directOutputEntriesForApp({
          rootDir: context.repoRoot,
          sourceRoot,
          sourceKeys,
          app,
          variant,
          manifest,
        })
        const mergedLines = entriesToLines(result.entries)
        const outputPath = path.join(appOutputDir(context.repoRoot, app), variant.output)
        const before = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
        const content = [
          '# AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.',
          `# Source: ${result.sourceLabel}`,
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
        continue
      }

      const shared = resolveLayer({
        rootDir: context.repoRoot,
        baseDir: path.join(sourceRoot, sharedKey),
        sourceKey: sharedKey,
        variant,
        manifest,
      })
      const scopedSourceKey = appSourceKey(app)
      const scoped = scopedSourceKey === sharedKey
        ? { entries: [], metadataPath: shared.metadataPath, sourceLabel: '' }
        : resolveLayer({
          rootDir: context.repoRoot,
          baseDir: path.join(sourceRoot, scopedSourceKey),
          sourceKey: scopedSourceKey,
          variant,
          manifest,
        })

      const sharedEntries = projectSharedLayer(
        shared.entries,
        app,
        sharedPrefixes,
        shared.metadataPath,
      )
      assertRequiredSharedAliases({
        sharedLayer: shared.entries,
        projectedLayer: sharedEntries,
        app,
        requiredAliases: sharedAliases,
      })
      if (shouldDisallowSharedOverrides) {
        assertNoSharedOverrides({
          sharedLayer: sharedEntries,
          scopedLayer: scoped.entries,
          app,
        })
      }
      const merged = mergeLayers([sharedEntries, scoped.entries])
      const mergedLines = entriesToLines(merged)
      const outputPath = path.join(appOutputDir(context.repoRoot, app), variant.output)
      const before = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
      const content = [
        '# AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.',
        `# Source: ${[shared.sourceLabel, scoped.sourceLabel].filter(Boolean).join(' + ')}`,
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
