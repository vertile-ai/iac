function isPlainObject(value: any): any {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function quote(value) {
  return JSON.stringify(String(value))
}

function formatKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : quote(key)
}

function formatValue(value, indent = 0) {
  const pad = ' '.repeat(indent)
  const nestedPad = ' '.repeat(indent + 2)

  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => `${nestedPad}${formatValue(item, indent + 2)},`).join('\n')}\n${pad}]`
  }

  if (isPlainObject(value)) {
    if (value.__raw) return value.value
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    return `{\n${entries.map(([key, item]) => `${nestedPad}${formatKey(key)} = ${formatValue(item, indent + 2)}`).join('\n')}\n${pad}}`
  }

  return quote(value)
}

export function block(type: any, labels: any[] = [], body: any = {}) {
  const labelText = labels.map((label) => ` ${quote(label)}`).join('')
  const lines = [`${type}${labelText} {`]

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    if (value && typeof value === 'object' && (value as any).__raw) {
      lines.push(`  ${key} = ${(value as any).value}`)
      continue
    }
    lines.push(`  ${key} = ${formatValue(value, 2)}`)
  }

  lines.push('}')
  return lines.join('\n')
}

export function nestedBlock(type: any, body: any = {}, indent = 0) {
  const pad = ' '.repeat(indent)
  const lines = [`${pad}${type} {`]

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    lines.push(`${pad}  ${key} = ${formatValue(value, indent + 2)}`)
  }

  lines.push(`${pad}}`)
  return lines.join('\n')
}

export function raw(value: any) {
  return { __raw: true, value }
}

export function sanitizeName(value: any) {
  const sanitized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return sanitized || 'resource'
}

export function renderGenericResources(resources: any[] = []) {
  return resources
    .map((resource) => block('resource', [resource.type, resource.name], resource.values || {}))
    .join('\n\n')
}

export function renderLocals(manifest: any, environment: any, deployment: any = {}) {
  return block('locals', [], {
    project_name: manifest.project.name,
    environment,
    deployment: deployment.name || undefined,
  })
}

export function renderRequiredProvider(name, source, version) {
  return [
    'terraform {',
    '  required_providers {',
    `    ${name} = {`,
    `      source  = ${quote(source)}`,
    `      version = ${quote(version)}`,
    '    }',
    '  }',
    '}',
  ].join('\n')
}

export function renderVariable(name, options = {}) {
  return block('variable', [name], options)
}

export function renderOutput(name, options = {}) {
  return block('output', [name], options)
}
