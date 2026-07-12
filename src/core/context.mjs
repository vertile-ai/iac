import fs from 'node:fs'
import path from 'node:path'
import { findProjectRoot } from '../shared.mjs'
import { readOption } from './args.mjs'

function resolveFrom(rootDir, value) {
  if (!value) return ''
  return path.isAbsolute(value) ? value : path.join(rootDir, value)
}

function defaultManifestPath(repoRoot, iacDir, hasExplicitIacDir) {
  if (!hasExplicitIacDir && fs.existsSync(path.join(repoRoot, 'iac.json'))) {
    return 'iac.json'
  }
  return path.relative(repoRoot, path.join(iacDir, 'iac.json'))
}

export function resolvePlatformContext(argv) {
  const repoRootArg = readOption(argv, '--repo-root')
  const repoRoot = repoRootArg
    ? path.resolve(repoRootArg)
    : findProjectRoot(process.cwd())
  const iacDirArg = readOption(argv, '--iac-dir')
  const iacDir = resolveFrom(
    repoRoot,
    iacDirArg || 'infrastructure/iac',
  )
  const iacManifestArg = readOption(argv, '--iac-manifest')
  const manifestPath = resolveFrom(
    repoRoot,
    iacManifestArg || defaultManifestPath(repoRoot, iacDir, Boolean(iacDirArg)),
  )
  const generatedRoot = resolveFrom(
    repoRoot,
    readOption(argv, '--out') || '.vertile/terraform',
  )

  return {
    repoRoot,
    iacDir,
    manifestPath,
    generatedRoot,
    terraformBin: readOption(argv, '--terraform-bin') || 'terraform',
  }
}

export function targetWorkspace(context, target, deploymentName = '') {
  return deploymentName
    ? path.join(context.generatedRoot, target, deploymentName)
    : path.join(context.generatedRoot, target)
}
