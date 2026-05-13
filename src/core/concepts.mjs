import { sanitizeName } from './hcl.mjs'

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

export function compactBody(body) {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined && value !== ''),
  )
}

export function terraformVariableName(...parts) {
  return resourceName(...parts)
}
