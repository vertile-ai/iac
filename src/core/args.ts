export const supportedTargets = ['vercel', 'aws', 'digitalocean']

export function readOption(argv, name) {
  const prefix = `${name}=`
  const inline = argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)

  const index = argv.indexOf(name)
  if (index !== -1) return argv[index + 1] || ''

  return ''
}

export function hasFlag(argv, name) {
  return argv.includes(name)
}

export function parseTargetOption(argv) {
  const target = readOption(argv, '--target') || 'all'
  if (target === 'all') return supportedTargets

  const targets = target
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  for (const value of targets) {
    if (!supportedTargets.includes(value)) {
      throw new Error(
        `Invalid --target value "${value}". Use one of: ${supportedTargets.join(', ')}, all`,
      )
    }
  }

  return [...new Set(targets)]
}

export function parseSingleTargetOption(argv) {
  const target = readOption(argv, '--target')
  if (!target || target === 'all' || target.includes(',')) {
    throw new Error(`--target must specify exactly one target: ${supportedTargets.join(', ')}.`)
  }
  const targets = parseTargetOption(argv)
  if (targets.length !== 1) {
    throw new Error(`--target must specify exactly one target: ${supportedTargets.join(', ')}.`)
  }
  return targets[0]
}

export function parseTerraformInitOptions(argv) {
  const migrateState = hasFlag(argv, '--migrate-state')
  const reconfigure = hasFlag(argv, '--reconfigure')
  if (migrateState && reconfigure) {
    throw new Error('--migrate-state and --reconfigure are mutually exclusive.')
  }
  return { migrateState, reconfigure }
}
