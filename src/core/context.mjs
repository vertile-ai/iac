import path from 'node:path'
import { findProjectRoot } from '../shared.mjs'
import { readOption } from './args.mjs'

function resolveFrom(rootDir, value) {
  if (!value) return ''
  return path.isAbsolute(value) ? value : path.join(rootDir, value)
}

export function resolvePlatformContext(argv) {
  const repoRootArg = readOption(argv, '--repo-root')
  const repoRoot = repoRootArg
    ? path.resolve(repoRootArg)
    : findProjectRoot(process.cwd())
  const iacDir = resolveFrom(
    repoRoot,
    readOption(argv, '--iac-dir') || 'infrastructure/iac',
  )
  const manifestPath = resolveFrom(
    repoRoot,
    readOption(argv, '--iac-manifest') || path.relative(repoRoot, path.join(iacDir, 'iac.json')),
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

export function targetWorkspace(context, target) {
  return path.join(context.generatedRoot, target)
}
