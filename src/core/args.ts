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
