import { sanitizeName } from './hcl.js'

export function providerValues(item, provider) {
  return {
    ...(item.values || {}),
    ...((item.providers && item.providers[provider]) || {}),
  }
}

export function resourceName(...parts) {
  return sanitizeName(parts.filter(Boolean).join('_'))
}

export function providerResourceName(manifest, environment, item) {
  return resourceName(manifest.project.name, environment, item.key)
}

export function providerObjectStorageName(manifest, environment, item, provider) {
  const values = providerValues(item, provider)
  return values.name || values.bucket || bucketName(manifest.project.name, environment, item.key)
}

export function bucketName(...parts) {
  const normalized = parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')

  return normalized.length >= 3 ? normalized : 'app-bucket'
}

export function compactBody(body) {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined && value !== ''),
  )
}

export function terraformVariableName(...parts) {
  return resourceName(...parts)
}
