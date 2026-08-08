// @ts-nocheck
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function execNode(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr })
    })
  })
}

function execCommand(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr })
    })
  })
}

async function createValidationFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-validate-'))
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'web'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'iac.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'validate-example' },
      environments: ['quality', 'production'],
      providers: {},
      packages: [{ key: 'web', directory: 'packages/web' }],
      env: {
        sync: { directOutputs: true, patchVariantsFromExample: true },
        metadata: {
          platform: {
            variables: [{
              key: 'DATABASE_URL',
              example: 'postgres://example',
              encrypted: true,
              browser: false,
              packages: ['web'],
              values: { quality: 'postgres://quality' },
            }],
          },
        },
      },
    }, null, 2) + '\n',
  )
  return root
}

async function createLegacyMetadataValidationFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-legacy-validate-'))
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  await mkdir(path.join(root, 'config', 'env', 'shared'), { recursive: true })
  await mkdir(path.join(root, 'config', 'env', 'web'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'web'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'api'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'iac.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'legacy-validate-example' },
      environments: ['quality', 'production'],
      providers: {},
      packages: [
        { key: 'web', directory: 'packages/web' },
        { key: 'api', directory: 'packages/api' },
      ],
      env: {
        sourceDir: 'config/env',
        sync: { directOutputs: true, packages: ['web'], disallowSharedOverrides: true },
      },
    }, null, 2) + '\n',
  )
  await writeFile(
    path.join(root, 'config', 'env', 'shared', '.env.json'),
    JSON.stringify({
      variables: [
        {
          key: 'DATABASE_URL', example: 'postgres://example', encrypted: true, browser: false,
          packages: ['web'], values: { quality: 'postgres://quality' },
        },
        {
          key: 'PRIVATE_ORIGIN', example: 'https://internal.example', encrypted: false, browser: false,
          packages: [{ package: 'web', key: 'NEXT_PUBLIC_ORIGIN' }], value: 'https://internal.example',
        },
        {
          key: 'API_ONLY', example: 'api', encrypted: false, browser: false,
          packages: ['api'], value: 'api',
        },
      ],
    }, null, 2) + '\n',
  )
  await writeFile(
    path.join(root, 'config', 'env', 'web', '.env.json'),
    JSON.stringify({
      variables: [{
        key: 'WEB_DATABASE_URL', example: 'postgres://web', encrypted: false, browser: false,
        packages: [{ package: 'web', key: 'DATABASE_URL' }], value: 'postgres://web',
      }],
    }, null, 2) + '\n',
  )
  const init = await execCommand('git', ['init', '--quiet'], root)
  assert.equal(init.code, 0, init.stderr)
  return root
}

test('validate is offline and reports direct-output coverage errors with no-op warnings', async () => {
  const root = await createValidationFixture()
  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'validate',
      '--repo-root', root,
    ], packageRoot)

    assert.equal(result.code, 1)
    assert.match(result.stderr, /values\.default, or values\.production/)
    assert.match(result.stderr, /patchVariantsFromExample is ignored when directOutputs is active/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate accepts ignored encrypted targets and rejects unsafe browser projections', async () => {
  const root = await createValidationFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.metadata.platform.variables[0].values.production = 'postgres://production'
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const init = await execCommand('git', ['init', '--quiet'], root)
    assert.equal(init.code, 0, init.stderr)
    await writeFile(path.join(root, '.gitignore'), 'packages/web/.env.*\n')

    const valid = await execNode([
      path.join(packageRoot, 'dist', 'src', 'validate.js'),
      '--repo-root', root,
    ], packageRoot)
    assert.equal(valid.code, 0, valid.stderr)
    assert.match(valid.stdout, /Validation passed/)
    assert.match(valid.stderr, /patchVariantsFromExample is ignored when directOutputs is active/)

    manifest.env.sync.disallowSharedOverrides = true
    manifest.env.metadata.shared = {
      variables: [{
        key: 'SERVICE_DATABASE_URL',
        example: 'postgres://service',
        encrypted: false,
        browser: false,
        packages: [{ package: 'web', key: 'DATABASE_URL' }],
        value: 'postgres://service',
      }],
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const collision = await execNode([
      path.join(packageRoot, 'dist', 'src', 'validate.js'),
      '--repo-root', root,
    ], packageRoot)
    assert.equal(collision.code, 1)
    assert.match(collision.stderr, /Shared\/output collision for web:DATABASE_URL/)

    delete manifest.env.metadata.shared
    manifest.env.metadata.platform.variables[0].key = 'NEXT_PUBLIC_DATABASE_URL'
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const unsafe = await execNode([
      path.join(packageRoot, 'dist', 'src', 'validate.js'),
      '--repo-root', root,
    ], packageRoot)
    assert.equal(unsafe.code, 1)
    assert.match(unsafe.stderr, /marks NEXT_PUBLIC_DATABASE_URL as browser=false/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validate applies all direct-output checks to legacy per-source env metadata', async () => {
  const root = await createLegacyMetadataValidationFixture()
  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'validate.js'),
      '--repo-root', root,
    ], packageRoot)

    assert.equal(result.code, 1)
    assert.match(result.stderr, /values\.default, or values\.production/)
    assert.match(result.stderr, /marks NEXT_PUBLIC_ORIGIN as browser=false/)
    assert.match(result.stderr, /package "api", which is not enabled for env\.sync output/)
    assert.match(result.stderr, /Shared\/output collision for web:DATABASE_URL/)
    assert.match(result.stderr, /Encrypted env target is not Git-ignored: packages\/web\/\.env\.quality/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
