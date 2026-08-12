class HclRaw {
  #value

  constructor(value) {
    this.#value = String(value)
  }

  get value() {
    return this.#value
  }
}

class HclHeredoc {
  #value
  #marker

  constructor(value, marker = 'EOT') {
    this.#value = String(value).replace(/\n$/, '')
    this.#marker = String(marker)
  }

  get value() {
    return this.#value
  }

  get marker() {
    return this.#marker
  }
}

class HclNestedBlock {
  #type
  #labels
  #body

  constructor(type, body = {}, labels: any[] = []) {
    this.#type = String(type)
    this.#labels = labels
    this.#body = body
  }

  get type() {
    return this.#type
  }

  get labels() {
    return this.#labels
  }

  get body() {
    return this.#body
  }
}

function isPlainObject(value: any): any {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function isRaw(value) {
  return value instanceof HclRaw
}

function isHeredoc(value) {
  return value instanceof HclHeredoc
}

function isNestedBlock(value) {
  return value instanceof HclNestedBlock
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

  if (isRaw(value)) return value.value
  if (isHeredoc(value)) return `<<-${value.marker}\n${value.value}\n${value.marker}`
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => `${nestedPad}${formatValue(item, indent + 2)},`).join('\n')}\n${pad}]`
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    return `{\n${entries.map(([key, item]) => `${nestedPad}${formatKey(key)} = ${formatValue(item, indent + 2)}`).join('\n')}\n${pad}}`
  }

  return quote(value)
}

export function block(type: any, labels: any[] = [], body: any = {}) {
  const labelText = labels.map((label) => ` ${quote(label)}`).join('')
  const lines = [`${type}${labelText} {`]

  lines.push(...bodyLines(body, 2))

  lines.push('}')
  return lines.join('\n')
}

export function nestedBlock(type: any, body: any = {}, indent = 0) {
  const pad = ' '.repeat(indent)
  const lines = [`${pad}${type} {`]

  lines.push(...bodyLines(body, indent + 2))

  lines.push(`${pad}}`)
  return lines.join('\n')
}

function renderNestedBlock(value, indent = 0) {
  const pad = ' '.repeat(indent)
  const labelText = value.labels.map((label) => ` ${quote(label)}`).join('')
  const lines = [`${pad}${value.type}${labelText} {`]
  lines.push(...bodyLines(value.body, indent + 2))
  lines.push(`${pad}}`)
  return lines.join('\n')
}

function bodyLines(body, indent) {
  const pad = ' '.repeat(indent)
  const lines: string[] = []

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    if (isNestedBlock(value)) {
      lines.push(renderNestedBlock(value, indent))
      continue
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isNestedBlock)) {
      lines.push(...value.map((item) => renderNestedBlock(item, indent)))
      continue
    }
    lines.push(`${pad}${key} = ${formatValue(value, indent)}`)
  }

  return lines
}

export function raw(value: any) {
  return new HclRaw(value)
}

export function heredoc(value: any, marker = 'EOT') {
  return new HclHeredoc(value, marker)
}

export function hclBlock(type: any, body: any = {}, labels: any[] = []) {
  return new HclNestedBlock(type, body, labels)
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
