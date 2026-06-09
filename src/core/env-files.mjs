const defaultEnvironmentFiles = {
  development: ['.env.development'],
  local: ['.env.local'],
  preview: ['.env.staging'],
  production: ['.env.production'],
  staging: ['.env.staging'],
  test: ['.env.test'],
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asFiles(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

export function environmentConfig(manifest, environment) {
  const configured = asObject(asObject(manifest.env).environments)[environment]
  if (typeof configured === 'string' || Array.isArray(configured)) {
    return { files: asFiles(configured) }
  }
  return asObject(configured)
}

export function environmentFiles(manifest, environment) {
  const config = environmentConfig(manifest, environment)
  const files = asFiles(config.files || config.sources || config.file)
  if (files.length > 0) return files
  return defaultEnvironmentFiles[environment] || [`.env.${environment}`]
}

export function environmentOutputFile(manifest, environment) {
  const config = environmentConfig(manifest, environment)
  return config.output || config.outputFile || defaultEnvironmentFiles[environment]?.[0] || `.env.${environment}`
}
