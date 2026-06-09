import fs from 'node:fs'
import path from 'node:path'

export function findProjectRoot(startDir) {
  let current = startDir
  const { root } = path.parse(current)

  while (true) {
    const hasPackageJson = fs.existsSync(path.join(current, 'package.json'))
    const hasInfrastructure = fs.existsSync(path.join(current, 'infrastructure'))
    if (hasPackageJson && hasInfrastructure) return current
    if (current === root) break
    current = path.dirname(current)
  }

  throw new Error(
    `Could not find project root from ${startDir}. Pass --repo-root or run inside a project with package.json and infrastructure/.`,
  )
}

export function readOption(argv, name) {
  const prefix = `${name}=`
  const inline = argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)

  const index = argv.indexOf(name)
  if (index !== -1) return argv[index + 1] || ''

  return ''
}

function splitList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function resolveFrom(rootDir, value) {
  if (!value) return ''
  return path.isAbsolute(value) ? value : path.join(rootDir, value)
}

export function resolveIacContext(argv, defaults = {}) {
  const repoRootArg = readOption(argv, '--repo-root')
  const repoRoot = repoRootArg
    ? path.resolve(repoRootArg)
    : findProjectRoot(process.cwd())

  const iacDir = resolveFrom(
    repoRoot,
    readOption(argv, '--iac-dir') || defaults.iacDir || 'infrastructure/iac',
  )
  const manifestArg = readOption(argv, '--manifest')
  const projectSettingsArg = readOption(argv, '--project-settings')
  const projectDomainsArg = readOption(argv, '--project-domains')
  const iacManifestArg = readOption(argv, '--iac-manifest')

  const autoCreateKeys = new Set([
    ...splitList(defaults.autoCreateKeys || ''),
    ...splitList(readOption(argv, '--auto-create-keys')),
  ])
  const autoCreatePrefixes = [
    ...splitList(defaults.autoCreatePrefixes || ''),
    ...splitList(readOption(argv, '--auto-create-prefixes')),
  ]

  return {
    repoRoot,
    iacDir,
    manifestPath: resolveFrom(
      repoRoot,
      manifestArg || path.relative(repoRoot, path.join(iacDir, 'env-manifest.json')),
    ),
    projectSettingsPath: resolveFrom(
      repoRoot,
      projectSettingsArg || path.relative(repoRoot, path.join(iacDir, 'project-settings.json')),
    ),
    projectDomainsPath: resolveFrom(
      repoRoot,
      projectDomainsArg || path.relative(repoRoot, path.join(iacDir, 'project-domains.json')),
    ),
    iacManifestPath: resolveFrom(
      repoRoot,
      iacManifestArg || path.relative(repoRoot, path.join(iacDir, 'iac.json')),
    ),
    tokenFilePath: resolveFrom(
      repoRoot,
      readOption(argv, '--token-file') || defaults.tokenFile || '.vercel.token',
    ),
    explicitManifestPath: Boolean(manifestArg),
    explicitProjectSettingsPath: Boolean(projectSettingsArg),
    explicitProjectDomainsPath: Boolean(projectDomainsArg),
    explicitIacManifestPath: Boolean(iacManifestArg),
    shouldAutoCreateProject(key) {
      return autoCreateKeys.has(key) || autoCreatePrefixes.some((prefix) => key.startsWith(prefix))
    },
  }
}

export function sharedOptionsHelp() {
  return `Shared options:
  --repo-root <path>              Project root containing infrastructure/.
  --iac-dir <path>                Directory containing project IaC manifests. Defaults to infrastructure/iac.
  --manifest <path>               Explicit legacy env manifest path.
  --project-settings <path>       Project settings manifest path.
  --project-domains <path>        Project domains manifest path.
  --iac-manifest <path>           Unified IaC manifest path. Defaults to <iac-dir>/iac.json.
  --token-file <path>             Token file. Defaults to <repo-root>/.vercel.token.
  --auto-create-keys <a,b>        Project keys allowed to be created in apply mode.
  --auto-create-prefixes <a,b>    Project key prefixes allowed to be created in apply mode.`
}
