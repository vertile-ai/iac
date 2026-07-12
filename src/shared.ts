import fs from 'node:fs'
import path from 'node:path'

export function findProjectRoot(startDir) {
  let current = startDir
  const { root } = path.parse(current)

  while (true) {
    const hasPackageJson = fs.existsSync(path.join(current, 'package.json'))
    const hasRootManifest = fs.existsSync(path.join(current, 'iac.json'))
    const hasInfrastructure = fs.existsSync(path.join(current, 'infrastructure'))
    if (hasPackageJson && (hasRootManifest || hasInfrastructure)) return current
    if (current === root) break
    current = path.dirname(current)
  }

  throw new Error(
    `Could not find project root from ${startDir}. Pass --repo-root or run inside a project with package.json plus iac.json or infrastructure/.`,
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

function defaultIacManifestPath(repoRoot, iacDir, hasExplicitIacDir) {
  if (!hasExplicitIacDir && fs.existsSync(path.join(repoRoot, 'iac.json'))) {
    return 'iac.json'
  }
  return path.relative(repoRoot, path.join(iacDir, 'iac.json'))
}

export function resolveIacContext(argv: string[], defaults: any = {}) {
  const repoRootArg = readOption(argv, '--repo-root')
  const repoRoot = repoRootArg
    ? path.resolve(repoRootArg)
    : findProjectRoot(process.cwd())

  const iacDirArg = readOption(argv, '--iac-dir')
  const iacDir = resolveFrom(
    repoRoot,
    iacDirArg || defaults.iacDir || 'infrastructure/iac',
  )
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
      iacManifestArg || defaultIacManifestPath(repoRoot, iacDir, Boolean(iacDirArg || defaults.iacDir)),
    ),
    tokenFilePath: resolveFrom(
      repoRoot,
      readOption(argv, '--token-file') || defaults.tokenFile || '.vercel.token',
    ),
    explicitProjectSettingsPath: Boolean(projectSettingsArg),
    explicitProjectDomainsPath: Boolean(projectDomainsArg),
    explicitIacManifestPath: Boolean(iacManifestArg),
    shouldAutoCreateProject(key) {
      return autoCreateKeys.has(key) || autoCreatePrefixes.some((prefix) => key.startsWith(prefix))
    },
  }
}

function readTokenFromFile(filePath) {
  if (!fs.existsSync(filePath)) return ''

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (trimmed.startsWith('VERCEL_TOKEN=')) {
      return trimmed.slice('VERCEL_TOKEN='.length).trim()
    }
    if (trimmed.startsWith('VERCEL_API_KEY=')) {
      return trimmed.slice('VERCEL_API_KEY='.length).trim()
    }

    return trimmed
  }

  return ''
}

function vercelTokenFromManifest(iacManifestPath) {
  if (!fs.existsSync(iacManifestPath)) return ''

  const manifest = JSON.parse(fs.readFileSync(iacManifestPath, 'utf8'))
  const vercel = manifest?.providers?.vercel
  if (!vercel || typeof vercel !== 'object' || Array.isArray(vercel)) {
    return ''
  }

  for (const key of ['token', 'apiKey']) {
    const value = vercel[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  return ''
}

export function readVercelToken(context, env = process.env) {
  return (
    env.VERCEL_TOKEN ||
    env.VERCEL_API_KEY ||
    vercelTokenFromManifest(context.iacManifestPath) ||
    readTokenFromFile(context.tokenFilePath)
  )
}

export function sharedOptionsHelp() {
  return `Shared options:
  --repo-root <path>              Project root containing iac.json or infrastructure/.
  --iac-dir <path>                Compatibility manifest directory. Defaults to infrastructure/iac.
  --project-settings <path>       Project settings manifest path.
  --project-domains <path>        Project domains manifest path.
  --iac-manifest <path>           Unified IaC manifest path. Defaults to iac.json when present, otherwise <iac-dir>/iac.json.
  --token-file <path>             Compatibility token file fallback. Defaults to <repo-root>/.vercel.token.
  --auto-create-keys <a,b>        Project keys allowed to be created in apply mode.
  --auto-create-prefixes <a,b>    Project key prefixes allowed to be created in apply mode.`
}
