export const defaultEnvSourceDir = '.vertile-iac/env'

export function envSourceDir(manifest) {
  return manifest.env.sourceDir || defaultEnvSourceDir
}
