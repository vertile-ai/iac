#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// This script runs from dist/scripts after TypeScript compilation.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function readOption(argv, name) {
  const prefix = `${name}=`
  const inline = argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)

  const index = argv.indexOf(name)
  if (index !== -1) return argv[index + 1] || ''

  return ''
}

const landingRoot = path.resolve(
  packageRoot,
  readOption(process.argv.slice(2), '--landing-root') || '../vertile-landing',
)

const files = [
  {
    source: path.join(packageRoot, 'schema', 'iac.schema.json'),
    output: path.join(landingRoot, 'public', 'schemas', 'iac.schema.json'),
  },
  {
    source: path.join(packageRoot, 'docs', 'schema', 'iac-manifest.schema-doc.json'),
    output: path.join(landingRoot, 'public', 'schemas', 'iac-manifest.schema-doc.json'),
  },
  {
    source: path.join(packageRoot, 'docs', 'schema', 'iac-schema-docs.schema.json'),
    output: path.join(landingRoot, 'public', 'schemas', 'iac-schema-docs.schema.json'),
  },
]

for (const file of files) {
  const content = await fs.readFile(file.source, 'utf8')
  await fs.mkdir(path.dirname(file.output), { recursive: true })
  await fs.writeFile(file.output, content, 'utf8')
  console.log(`Synced ${path.relative(landingRoot, file.output)} from ${path.relative(packageRoot, file.source)}`)
}
