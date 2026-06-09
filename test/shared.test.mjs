import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { supportedTargets } from '../src/core/args.mjs'
import { applyEnvMetadata } from '../src/core/env-metadata.mjs'
import { readManifest } from '../src/core/manifest.mjs'
import {
  readVercelEnvManifest,
  vercelEnvManifestFromIac,
} from '../src/core/vercel-manifests.mjs'
import { resolveIacContext } from '../src/shared.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-'))
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  await mkdir(path.join(root, 'infrastructure', 'shared'), { recursive: true })
  await mkdir(path.join(root, 'infrastructure', 'app'), { recursive: true })

  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'env-manifest.json'),
    JSON.stringify(
      {
        teamSlug: 'example-team',
        sourceDir: 'infrastructure',
        projects: [{ key: 'app', id: 'prj_test', name: 'example-app' }],
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'project-settings.json'),
    JSON.stringify({ projects: [{ key: 'app', rootDirectory: 'packages/app' }] }, null, 2) + '\n',
  )
  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'project-domains.json'),
    JSON.stringify({ projects: [{ key: 'app', domains: ['app.example.com'] }] }, null, 2) + '\n',
  )
  await writeFile(path.join(root, 'infrastructure', 'shared', '.env.staging'), 'SHARED=value\n')
  await writeFile(path.join(root, 'infrastructure', 'app', '.env.staging'), 'APP=value\n')
  await writeFile(path.join(root, 'infrastructure', 'shared', '.env.development'), 'SHARED=value\n')
  await writeFile(path.join(root, 'infrastructure', 'app', '.env.development'), 'APP=value\n')

  return root
}

async function createUnifiedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-'))
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  await mkdir(path.join(root, 'config', 'env', 'shared'), { recursive: true })
  await mkdir(path.join(root, 'config', 'env', 'app'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true })

  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'iac.json'),
    JSON.stringify(
      {
        version: 1,
        project: { name: 'example' },
        environments: ['preview', 'production'],
        providers: {
          vercel: {
            teamSlug: 'example-team',
            projectDefaults: {
              nodeVersion: '24.x',
              enableAffectedProjectsDeployments: true,
            },
          },
        },
        env: {
          sourceDir: 'config/env',
          sync: {
            apps: ['app'],
          },
        },
        apps: [
          {
            key: 'app',
            id: 'prj_test',
            name: 'example-app',
            framework: 'nextjs',
            rootDirectory: 'packages/app',
            domains: [
              'app.example.com',
              { name: 'app-preview.example.com', gitBranch: 'preview' },
            ],
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(path.join(root, 'config', 'env', 'shared', '.env.staging'), 'SHARED=value\n')
  await writeFile(path.join(root, 'config', 'env', 'app', '.env.staging'), 'APP=value\n')

  return root
}

async function createEnvMetadataFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-'))
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  await mkdir(path.join(root, 'config', 'env', 'shared'), { recursive: true })
  await mkdir(path.join(root, 'config', 'env', 'web'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'web'), { recursive: true })

  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'iac.json'),
    JSON.stringify(
      {
        version: 1,
        project: { name: 'env-metadata' },
        environments: ['staging', 'production'],
        providers: {
          vercel: { teamSlug: 'example-team' },
        },
        env: {
          sourceDir: 'config/env',
          sync: {
            apps: ['web'],
          },
        },
        apps: [
          {
            key: 'web',
            id: 'prj_web',
            name: 'env-metadata-web',
            framework: 'nextjs',
            rootDirectory: 'packages/web',
            env: { sharedPrefix: 'WEB_' },
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(
    path.join(root, 'config', 'env', 'shared', '.env.staging'),
    [
      'WEB_NEXT_PUBLIC_BASE_URL=https://staging.example.com',
      'DATABASE_URL=postgres://staging',
      '',
    ].join('\n'),
  )
  await writeFile(
    path.join(root, 'config', 'env', 'shared', '.env.production'),
    [
      'WEB_NEXT_PUBLIC_BASE_URL=https://example.com',
      'DATABASE_URL=postgres://production',
      '',
    ].join('\n'),
  )
  await writeFile(
    path.join(root, 'config', 'env', 'shared', '.env.json'),
    JSON.stringify(
      {
        variables: [
          {
            key: 'WEB_NEXT_PUBLIC_BASE_URL',
            example: 'https://example.com',
            encrypted: false,
            browser: true,
          },
          {
            key: 'DATABASE_URL',
            example: 'postgres://user:password@host/db',
            encrypted: true,
            browser: false,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(path.join(root, 'config', 'env', 'web', '.env.staging'), 'PORT=3000\n')
  await writeFile(path.join(root, 'config', 'env', 'web', '.env.production'), 'PORT=3000\n')
  await writeFile(
    path.join(root, 'config', 'env', 'web', '.env.json'),
    JSON.stringify(
      {
        variables: [
          {
            key: 'PORT',
            example: '3000',
            encrypted: false,
            browser: false,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )

  return root
}

async function createDefaultEnvSourceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-'))
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  await mkdir(path.join(root, '.vertile-iac', 'env', 'shared'), { recursive: true })
  await mkdir(path.join(root, '.vertile-iac', 'env', 'api'), { recursive: true })

  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'iac.json'),
    JSON.stringify(
      {
        version: 1,
        project: { name: 'default-env-source' },
        environments: ['preview', 'production'],
        providers: {
          vercel: {
            teamSlug: 'example-team',
            env: {
              targets: {
                preview: { environment: 'uat' },
              },
            },
          },
        },
        env: {
          environments: {
            uat: {
              files: ['.env.uat', '.env.uat.local'],
              output: '.env.uat',
            },
          },
        },
        apps: [
          {
            key: 'api',
            id: 'prj_api',
            name: 'default-env-api',
            framework: 'node',
            rootDirectory: '.',
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(
    path.join(root, '.vertile-iac', 'env', 'shared', '.env.staging'),
    'SHARED=value\nOVERRIDE=shared\n',
  )
  await writeFile(
    path.join(root, '.vertile-iac', 'env', 'api', '.env.staging'),
    'API=value\nOVERRIDE=api\n',
  )
  await writeFile(path.join(root, '.vertile-iac', 'env', 'shared', '.env.uat'), 'SHARED_UAT=base\n')
  await writeFile(path.join(root, '.vertile-iac', 'env', 'shared', '.env.uat.local'), 'SHARED_UAT=local\n')
  await writeFile(path.join(root, '.vertile-iac', 'env', 'api', '.env.uat'), 'API_UAT=value\n')

  return root
}

function execNode(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout,
        stderr,
      })
    })
  })
}

function declaredTargets(manifest) {
  return supportedTargets.filter((target) => manifest.providers[target])
}

test('resolves explicit project paths and auto-create controls', async () => {
  const root = await createFixture()

  try {
    const context = resolveIacContext([
      '--repo-root',
      root,
      '--auto-create-keys=app',
      '--auto-create-prefixes=template-',
    ])

    assert.equal(context.repoRoot, root)
    assert.equal(context.manifestPath, path.join(root, 'infrastructure', 'iac', 'env-manifest.json'))
    assert.equal(context.iacManifestPath, path.join(root, 'infrastructure', 'iac', 'iac.json'))
    assert.equal(context.shouldAutoCreateProject('app'), true)
    assert.equal(context.shouldAutoCreateProject('template-demo'), true)
    assert.equal(context.shouldAutoCreateProject('other'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('syncs package env files from unified iac.json env source', async () => {
  const root = await createUnifiedFixture()

  try {
    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
    ], packageRoot)

    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Added packages\/app\/\.env\.staging SHARED/)
    assert.match(result.stdout, /Added packages\/app\/\.env\.staging APP/)
    assert.equal(result.stderr, '')

    const content = await readFile(path.join(root, 'packages', 'app', '.env.staging'), 'utf8')
    assert.match(content, /Source: config\/env\/shared\/\.env\.staging \+ config\/env\/app\/\.env\.staging/)
    assert.match(content, /^SHARED=value$/m)
    assert.match(content, /^APP=value$/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('syncs single-source apps without layering the same source twice', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.sync.sharedKey = 'app'
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
    ], packageRoot)

    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')

    const content = await readFile(path.join(root, 'packages', 'app', '.env.staging'), 'utf8')
    assert.match(content, /Source: config\/env\/app\/\.env\.staging/)
    assert.doesNotMatch(content, /config\/env\/app\/\.env\.staging \+ config\/env\/app\/\.env\.staging/)
    assert.match(content, /^APP=value$/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('patches and reconciles selected env variants from examples', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.sync.patchVariantsFromExample = true
    manifest.env.environments = {
      local: { files: ['.env.local'], strict: false },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(
      path.join(root, 'config', 'env', 'shared', '.env.example'),
      'SHARED=from-example\n',
    )
    await writeFile(
      path.join(root, 'config', 'env', 'app', '.env.example'),
      'APP=from-example\n',
    )

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=local',
    ], packageRoot)

    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Patched config\/env\/shared\/\.env\.local SHARED/)
    assert.match(result.stdout, /Added packages\/app\/\.env\.local SHARED/)

    await writeFile(
      path.join(root, 'config', 'env', 'app', '.env.local'),
      'APP=kept\nSTALE=removed\n',
    )
    await writeFile(
      path.join(root, 'config', 'env', 'shared', '.env.json'),
      JSON.stringify(
        {
          variables: [
            {
              key: 'SHARED',
              example: 'from-example',
              encrypted: true,
              browser: false,
            },
          ],
        },
        null,
        2,
      ) + '\n',
    )
    await writeFile(
      path.join(root, 'config', 'env', 'app', '.env.json'),
      JSON.stringify(
        {
          variables: [
            {
              key: 'APP',
              example: 'from-example',
              encrypted: true,
              browser: false,
            },
          ],
        },
        null,
        2,
      ) + '\n',
    )

    const reconcileResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=local',
      '--reconcile-delete',
    ], packageRoot)

    assert.equal(reconcileResult.code, 0)
    assert.match(reconcileResult.stdout, /Patched config\/env\/app\/\.env\.local STALE \(removed-stale-key\)/)

    const appLocal = await readFile(path.join(root, 'config', 'env', 'app', '.env.local'), 'utf8')
    assert.match(appLocal, /^APP=kept$/m)
    assert.doesNotMatch(appLocal, /^STALE=/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reconcile-delete treats env metadata as the source of truth', async () => {
  const root = await createEnvMetadataFixture()

  try {
    await writeFile(
      path.join(root, 'config', 'env', 'web', '.env.staging'),
      'PORT=3000\nPRIVATE_TOKEN=secret\nSTALE=removed\n',
    )
    await writeFile(
      path.join(root, 'config', 'env', 'web', '.env.json'),
      JSON.stringify(
        {
          variables: [
            {
              key: 'PORT',
              example: '3000',
              encrypted: false,
              browser: false,
            },
            {
              key: 'PRIVATE_TOKEN',
              example: 'replace-me',
              encrypted: true,
              browser: false,
              includeInExample: false,
            },
          ],
        },
        null,
        2,
      ) + '\n',
    )
    await writeFile(path.join(root, 'config', 'env', 'web', '.env.example'), 'PORT=3000\n')

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
      '--reconcile-delete',
    ], packageRoot)

    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Patched config\/env\/web\/\.env\.staging STALE \(removed-stale-key\)/)
    assert.equal(result.stderr, '')

    const webStaging = await readFile(path.join(root, 'config', 'env', 'web', '.env.staging'), 'utf8')
    assert.match(webStaging, /^PORT=3000$/m)
    assert.match(webStaging, /^PRIVATE_TOKEN=secret$/m)
    assert.doesNotMatch(webStaging, /^STALE=/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reconcile-delete warns and leaves variant files unchanged without env metadata', async () => {
  const root = await createUnifiedFixture()

  try {
    await writeFile(path.join(root, 'config', 'env', 'app', '.env.example'), 'APP=from-example\n')
    await writeFile(path.join(root, 'config', 'env', 'app', '.env.staging'), 'APP=value\nSTALE=kept\n')

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
      '--reconcile-delete',
    ], packageRoot)

    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /Skipping reconcile-delete for config\/env\/shared\/\.env\.staging; missing config\/env\/shared\/\.env\.json/)
    assert.match(result.stderr, /Skipping reconcile-delete for config\/env\/app\/\.env\.staging; missing config\/env\/app\/\.env\.json/)

    const appStaging = await readFile(path.join(root, 'config', 'env', 'app', '.env.staging'), 'utf8')
    assert.match(appStaging, /^APP=value$/m)
    assert.match(appStaging, /^STALE=kept$/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('uses iac.json env metadata and respects excludeEnv when populating variants', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.sync.patchVariantsFromExample = true
    manifest.env.metadata = {
      shared: {
        variables: [
          {
            key: 'SHARED',
            example: 'shared',
            encrypted: true,
            browser: false,
          },
        ],
      },
      app: {
        variables: [
          {
            key: 'APP',
            example: 'app',
            encrypted: true,
            browser: false,
          },
          {
            key: 'PREVIEW_ONLY',
            example: 'preview-only',
            encrypted: false,
            browser: false,
            excludeEnv: ['production'],
          },
        ],
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(path.join(root, 'config', 'env', 'shared', '.env.example'), 'SHARED=shared\n')
    await writeFile(
      path.join(root, 'config', 'env', 'app', '.env.example'),
      'APP=app\nPREVIEW_ONLY=preview-only\n',
    )

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=preview,production',
    ], packageRoot)

    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')

    const previewSource = await readFile(path.join(root, 'config', 'env', 'app', '.env.staging'), 'utf8')
    assert.match(previewSource, /^PREVIEW_ONLY=preview-only$/m)

    const productionSource = await readFile(path.join(root, 'config', 'env', 'app', '.env.production'), 'utf8')
    assert.match(productionSource, /^APP=app$/m)
    assert.doesNotMatch(productionSource, /^PREVIEW_ONLY=/m)

    const productionPackage = await readFile(path.join(root, 'packages', 'app', '.env.production'), 'utf8')
    assert.match(productionPackage, /^APP=app$/m)
    assert.doesNotMatch(productionPackage, /^PREVIEW_ONLY=/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('respects includeEnv and excludeEnv precedence when populating variants', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.sync.patchVariantsFromExample = true
    manifest.env.metadata = {
      shared: {
        variables: [
          {
            key: 'SHARED',
            example: 'shared',
            encrypted: true,
            browser: false,
          },
        ],
      },
      app: {
        variables: [
          {
            key: 'APP',
            example: 'app',
            encrypted: true,
            browser: false,
          },
          {
            key: 'INCLUDE_PREVIEW_ONLY',
            example: 'preview',
            encrypted: false,
            browser: false,
            includeEnv: ['preview'],
          },
          {
            key: 'INCLUDE_AFTER_EXCLUDE',
            example: 'preview-after-exclude',
            encrypted: false,
            browser: false,
            excludeEnv: ['production'],
            includeEnv: ['preview', 'production'],
          },
        ],
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(path.join(root, 'config', 'env', 'shared', '.env.example'), 'SHARED=shared\n')
    await writeFile(
      path.join(root, 'config', 'env', 'app', '.env.example'),
      [
        'APP=app',
        'INCLUDE_PREVIEW_ONLY=preview',
        'INCLUDE_AFTER_EXCLUDE=preview-after-exclude',
        '',
      ].join('\n'),
    )

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=preview,production',
    ], packageRoot)

    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')

    const previewSource = await readFile(path.join(root, 'config', 'env', 'app', '.env.staging'), 'utf8')
    assert.match(previewSource, /^INCLUDE_PREVIEW_ONLY=preview$/m)
    assert.match(previewSource, /^INCLUDE_AFTER_EXCLUDE=preview-after-exclude$/m)

    const productionSource = await readFile(path.join(root, 'config', 'env', 'app', '.env.production'), 'utf8')
    assert.match(productionSource, /^APP=app$/m)
    assert.doesNotMatch(productionSource, /^INCLUDE_PREVIEW_ONLY=/m)
    assert.doesNotMatch(productionSource, /^INCLUDE_AFTER_EXCLUDE=/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('does not create empty variant files when metadata excludes all example keys', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.sync.patchVariantsFromExample = true
    manifest.env.metadata = {
      shared: {
        variables: [
          {
            key: 'PREVIEW_ONLY',
            example: 'preview',
            encrypted: false,
            browser: false,
            includeEnv: ['preview'],
          },
        ],
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(
      path.join(root, 'config', 'env', 'shared', '.env.example'),
      'PREVIEW_ONLY=preview\n',
    )

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=production',
    ], packageRoot)

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Missing required env source file: config\/env\/shared\/\.env\.production/)

    await assert.rejects(
      stat(path.join(root, 'config', 'env', 'shared', '.env.production')),
      { code: 'ENOENT' },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('respects includeEnv and excludeEnv when non-strict variants layer examples', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.environments = {
      production: {
        files: ['.env.production'],
        strict: false,
      },
    }
    manifest.env.metadata = {
      shared: {
        variables: [
          {
            key: 'SHARED',
            example: 'shared',
            encrypted: true,
            browser: false,
          },
        ],
      },
      app: {
        variables: [
          {
            key: 'APP',
            example: 'app',
            encrypted: true,
            browser: false,
          },
          {
            key: 'LOCAL_ONLY',
            example: 'local',
            encrypted: false,
            browser: false,
            includeEnv: ['preview'],
          },
        ],
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(path.join(root, 'config', 'env', 'shared', '.env.example'), 'SHARED=shared\n')
    await writeFile(
      path.join(root, 'config', 'env', 'app', '.env.example'),
      'APP=app\nLOCAL_ONLY=local\n',
    )
    await writeFile(path.join(root, 'config', 'env', 'shared', '.env.production'), 'SHARED=prod\n')
    await writeFile(path.join(root, 'config', 'env', 'app', '.env.production'), 'APP=prod\n')

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=production',
    ], packageRoot)

    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')

    const productionPackage = await readFile(path.join(root, 'packages', 'app', '.env.production'), 'utf8')
    assert.match(productionPackage, /^APP=prod$/m)
    assert.doesNotMatch(productionPackage, /^LOCAL_ONLY=/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('ignores env metadata excludeEnv values outside manifest environments', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.sync.patchVariantsFromExample = true
    manifest.env.metadata = {
      app: {
        variables: [
          {
            key: 'APP',
            example: 'app',
            encrypted: true,
            browser: false,
          },
          {
            key: 'PREVIEW_ONLY',
            example: 'preview',
            encrypted: false,
            browser: false,
            excludeEnv: ['qa', 'production'],
          },
        ],
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(
      path.join(root, 'config', 'env', 'app', '.env.example'),
      'APP=app\nPREVIEW_ONLY=preview\n',
    )
    await writeFile(path.join(root, 'config', 'env', 'shared', '.env.production'), 'SHARED=production\n')

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=preview,production',
    ], packageRoot)

    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')

    const previewSource = await readFile(path.join(root, 'config', 'env', 'app', '.env.staging'), 'utf8')
    assert.match(previewSource, /^PREVIEW_ONLY=preview$/m)

    const productionSource = await readFile(path.join(root, 'config', 'env', 'app', '.env.production'), 'utf8')
    assert.doesNotMatch(productionSource, /^PREVIEW_ONLY=/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ignores env metadata includeEnv values outside manifest environments', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.sync.patchVariantsFromExample = true
    manifest.env.metadata = {
      app: {
        variables: [
          {
            key: 'APP',
            example: 'app',
            encrypted: true,
            browser: false,
          },
          {
            key: 'PREVIEW_OR_UNKNOWN',
            example: 'preview',
            encrypted: false,
            browser: false,
            includeEnv: ['preview', 'qa'],
          },
          {
            key: 'UNKNOWN_ONLY',
            example: 'unknown',
            encrypted: false,
            browser: false,
            includeEnv: ['qa'],
          },
        ],
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(
      path.join(root, 'config', 'env', 'app', '.env.example'),
      'APP=app\nPREVIEW_OR_UNKNOWN=preview\nUNKNOWN_ONLY=unknown\n',
    )
    await writeFile(path.join(root, 'config', 'env', 'shared', '.env.production'), 'SHARED=production\n')

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=preview,production',
    ], packageRoot)

    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')

    const previewSource = await readFile(path.join(root, 'config', 'env', 'app', '.env.staging'), 'utf8')
    assert.match(previewSource, /^PREVIEW_OR_UNKNOWN=preview$/m)
    assert.doesNotMatch(previewSource, /^UNKNOWN_ONLY=/m)

    const productionSource = await readFile(path.join(root, 'config', 'env', 'app', '.env.production'), 'utf8')
    assert.doesNotMatch(productionSource, /^PREVIEW_OR_UNKNOWN=/m)
    assert.doesNotMatch(productionSource, /^UNKNOWN_ONLY=/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('derives Vercel env manifest with embedded iac env metadata', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    rawManifest.env.metadata = {
      app: {
        variables: [
          {
            key: 'APP',
            example: 'app',
            encrypted: false,
            browser: false,
          },
        ],
      },
    }
    await writeFile(manifestPath, JSON.stringify(rawManifest, null, 2) + '\n')

    const manifest = readManifest(manifestPath)
    const envManifest = vercelEnvManifestFromIac(manifest)

    assert.deepEqual(envManifest.environments, ['preview', 'production'])
    assert.equal(envManifest.env.metadata.app.variables[0].key, 'APP')
    assert.equal(envManifest.env.metadata.app.variables[0].encrypted, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('defaults to iac.json when legacy env manifest is also present', async () => {
  const root = await createUnifiedFixture()
  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'env-manifest.json'),
    JSON.stringify(
      {
        teamSlug: 'legacy-team',
        sourceDir: 'legacy-env',
        projects: [{ key: 'legacy', id: 'prj_legacy', name: 'legacy-app' }],
      },
      null,
      2,
    ) + '\n',
  )

  try {
    const context = resolveIacContext(['--repo-root', root])
    const manifest = readVercelEnvManifest(context)

    assert.equal(manifest.teamSlug, 'example-team')
    assert.equal(manifest.sourceDir, 'config/env')
    assert.deepEqual(manifest.projects.map(({ key }) => key), ['app'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('can reject app env keys that override shared env keys', async () => {
  const root = await createUnifiedFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.sync.disallowSharedOverrides = true
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(
      path.join(root, 'config', 'env', 'app', '.env.staging'),
      'APP=value\nSHARED=app-override\n',
    )

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
    ], packageRoot)

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Detected shared env key overrides for app "app": SHARED/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validates .env.json metadata and projects browser-safe shared keys', async () => {
  const root = await createEnvMetadataFixture()

  try {
    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
    ], packageRoot)

    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')

    const content = await readFile(path.join(root, 'packages', 'web', '.env.staging'), 'utf8')
    assert.match(content, /^NEXT_PUBLIC_BASE_URL=https:\/\/staging\.example\.com$/m)
    assert.match(content, /^PORT=3000$/m)
    assert.doesNotMatch(content, /^DATABASE_URL=/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applies encrypted and plaintext cloud storage metadata to env entries', async () => {
  const root = await createEnvMetadataFixture()

  try {
    const entries = applyEnvMetadata({
      baseDir: path.join(root, 'config', 'env', 'shared'),
      manifest: {},
      entries: [
        { key: 'WEB_NEXT_PUBLIC_BASE_URL', value: 'https://example.com' },
        { key: 'DATABASE_URL', value: 'postgres://production' },
      ],
    })

    assert.equal(
      entries.find((entry) => entry.key === 'WEB_NEXT_PUBLIC_BASE_URL').encrypted,
      false,
    )
    assert.equal(
      entries.find((entry) => entry.key === 'DATABASE_URL').encrypted,
      true,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('exports .env.example from object-map .env.json metadata', async () => {
  const root = await createEnvMetadataFixture()

  try {
    await writeFile(
      path.join(root, 'config', 'env', 'shared', '.env.json'),
      JSON.stringify(
        {
          vars: {
            WEB_NEXT_PUBLIC_BASE_URL: {
              example: 'https://example.com',
              encrypted: false,
              browser: true,
            },
            DATABASE_URL: {
              example: 'postgres://user:password@host/db',
              encrypted: true,
              browser: false,
              includeInExample: false,
            },
          },
        },
        null,
        2,
      ) + '\n',
    )

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
      '--write-examples',
    ], packageRoot)

    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /Wrote config\/env\/shared\/\.env\.example/)

    const example = await readFile(path.join(root, 'config', 'env', 'shared', '.env.example'), 'utf8')
    assert.match(example, /^WEB_NEXT_PUBLIC_BASE_URL=https:\/\/example\.com$/m)
    assert.doesNotMatch(example, /^DATABASE_URL=/m)

    const synced = await readFile(path.join(root, 'packages', 'web', '.env.staging'), 'utf8')
    assert.match(synced, /^NEXT_PUBLIC_BASE_URL=https:\/\/staging\.example\.com$/m)
    assert.doesNotMatch(synced, /^DATABASE_URL=/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('requires .env.json metadata for every env key when metadata exists', async () => {
  const root = await createEnvMetadataFixture()

  try {
    await writeFile(
      path.join(root, 'config', 'env', 'web', '.env.staging'),
      'PORT=3000\nMISSING=value\n',
    )

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
    ], packageRoot)

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /\.env\.json must define metadata for MISSING/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('blocks sharedPrefix projection for env metadata marked browser false', async () => {
  const root = await createEnvMetadataFixture()

  try {
    await writeFile(
      path.join(root, 'config', 'env', 'shared', '.env.json'),
      JSON.stringify(
        {
          variables: [
            {
              key: 'WEB_NEXT_PUBLIC_BASE_URL',
              example: 'https://example.com',
              encrypted: false,
              browser: false,
            },
            {
              key: 'DATABASE_URL',
              example: 'postgres://user:password@host/db',
              encrypted: true,
              browser: false,
            },
          ],
        },
        null,
        2,
      ) + '\n',
    )

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
    ], packageRoot)

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /WEB_NEXT_PUBLIC_BASE_URL as browser=false/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports embedded env metadata labels when browser projection is blocked', async () => {
  const root = await createEnvMetadataFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.metadata = {
      shared: {
        variables: [
          {
            key: 'WEB_NEXT_PUBLIC_BASE_URL',
            example: 'https://example.com',
            encrypted: false,
            browser: false,
          },
          {
            key: 'DATABASE_URL',
            example: 'postgres://user:password@host/db',
            encrypted: true,
            browser: false,
          },
        ],
      },
      web: {
        variables: [
          {
            key: 'PORT',
            example: '3000',
            encrypted: false,
            browser: false,
          },
        ],
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
    ], packageRoot)

    assert.notEqual(result.code, 0)
    assert.match(
      result.stderr,
      /iac\.json env\.metadata\.shared marks WEB_NEXT_PUBLIC_BASE_URL as browser=false/,
    )
    assert.doesNotMatch(result.stderr, /\.\.\/.*iac\.json env\.metadata\.shared/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('standalone env metadata schema documents vars-only object maps', async () => {
  const schema = JSON.parse(
    await readFile(path.join(packageRoot, 'schema', 'env-metadata.schema.json'), 'utf8'),
  )

  assert.doesNotMatch(schema.required?.join(',') || '', /\bvariables\b/)
  assert.ok(schema.properties.vars)
})

test('defaults iac.json env source to .vertile-iac/env for single-package apps', async () => {
  const root = await createDefaultEnvSourceFixture()

  try {
    const syncResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging',
    ], packageRoot)

    assert.equal(syncResult.code, 0)
    assert.match(syncResult.stdout, /Added \.env\.staging SHARED/)
    assert.match(syncResult.stdout, /Added \.env\.staging API/)
    assert.equal(syncResult.stderr, '')

    const content = await readFile(path.join(root, '.env.staging'), 'utf8')
    assert.match(content, /Source: \.vertile-iac\/env\/shared\/\.env\.staging \+ \.vertile-iac\/env\/api\/\.env\.staging/)
    assert.match(content, /^SHARED=value$/m)
    assert.match(content, /^API=value$/m)
    assert.match(content, /^OVERRIDE=api$/m)
    assert.doesNotMatch(content, /^OVERRIDE=shared$/m)

    const uatResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=uat',
    ], packageRoot)

    assert.equal(uatResult.code, 0)
    assert.equal(uatResult.stderr, '')

    const uatContent = await readFile(path.join(root, '.env.uat'), 'utf8')
    assert.match(uatContent, /Source: \.vertile-iac\/env\/shared\/\.env\.uat \+ \.vertile-iac\/env\/shared\/\.env\.uat\.local \+ \.vertile-iac\/env\/api\/\.env\.uat/)
    assert.match(uatContent, /^SHARED_UAT=local$/m)
    assert.match(uatContent, /^API_UAT=value$/m)

    const envResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'env',
      '--repo-root',
      root,
      '--scope=all',
      '--targets=preview',
    ], packageRoot)

    assert.equal(envResult.code, 0)
    assert.match(envResult.stdout, /default-env-api/)
    assert.match(envResult.stdout, /API_UAT/)
    assert.equal(envResult.stderr, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses Vercel reconcile-delete when env source files are missing', async () => {
  const root = await createDefaultEnvSourceFixture()

  try {
    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'env',
      '--repo-root',
      root,
      '--scope=all',
      '--targets=production',
      '--reconcile-delete',
    ], packageRoot)

    assert.equal(result.code, 1)
    assert.match(result.stderr, /Missing required env source file\(s\) for --reconcile-delete/)
    assert.match(result.stderr, /\.vertile-iac\/env\/shared\/\.env\.production/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runs Vercel compatibility dry-runs from unified iac.json', async () => {
  const root = await createUnifiedFixture()

  try {
    const envResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'env',
      '--repo-root',
      root,
      '--scope=all',
      '--targets=preview',
    ], packageRoot)

    assert.equal(envResult.code, 0)
    assert.match(envResult.stdout, /example-app/)
    assert.match(envResult.stdout, /APP/)
    assert.equal(envResult.stderr, '')

    const projectsResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'projects',
      '--repo-root',
      root,
      '--projects=app',
    ], packageRoot)

    assert.equal(projectsResult.code, 0)
    assert.match(projectsResult.stdout, /dry-run\/offline.*app/)
    assert.equal(projectsResult.stderr, '')

    const domainsResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'domains',
      '--repo-root',
      root,
      '--projects=app',
    ], packageRoot)

    assert.equal(domainsResult.code, 0)
    assert.match(domainsResult.stdout, /app-preview\.example\.com/)
    assert.equal(domainsResult.stderr, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runs env dry-run offline against a target project fixture', async () => {
  const root = await createFixture()

  try {
    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'env',
      '--repo-root',
      root,
      '--scope=all',
      '--targets=preview',
    ], packageRoot)

    assert.equal(result.code, 0)
    assert.match(result.stdout, /Mode:.*dry-run/)
    assert.match(result.stdout, /example-app/)
    assert.equal(result.stderr, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime examples expose base and provider-specific manifests that render', async () => {
  const expectedExamples = [
    'bun-hono-api',
    'go-api',
    'next-monorepo',
    'node-api',
    'python-fastapi-api',
    'react-spa',
    'sveltekit-web',
  ]
  const examplesRoot = path.join(packageRoot, 'examples')
  const examples = (await readdir(examplesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  assert.deepEqual(examples, expectedExamples)

  for (const example of examples) {
    const iacDir = path.join(examplesRoot, example, 'infrastructure', 'iac')
    const manifestNames = (await readdir(iacDir))
      .filter((name) => /^iac(\.(aws|do|vercel))?\.json$/.test(name))
      .sort()

    assert.ok(manifestNames.includes('iac.json'), `${example} must include iac.json`)
    assert.ok(manifestNames.length > 1, `${example} must include provider-specific iac files`)

    for (const manifestName of manifestNames) {
      const root = await mkdtemp(path.join(tmpdir(), `vertile-iac-${example}-`))
      await cp(path.join(examplesRoot, example), root, { recursive: true })

      try {
        const manifestPath = path.join(root, 'infrastructure', 'iac', manifestName)
        const manifest = readManifest(manifestPath)
        const targets = declaredTargets(manifest)

        assert.ok(targets.length > 0, `${example}/${manifestName} must declare a supported provider`)

        const renderResult = await execNode([
          path.join(packageRoot, 'src', 'cli.mjs'),
          'render',
          '--repo-root',
          root,
          '--iac-manifest',
          manifestPath,
          '--target',
          targets.join(','),
          '--env=production',
        ], packageRoot)

        assert.equal(renderResult.code, 0)
        assert.equal(renderResult.stderr, '')
        for (const target of targets) {
          assert.match(renderResult.stdout, new RegExp(target))
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

test('published Next.js monorepo example exercises Vercel env and render flows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-next-monorepo-'))
  await cp(path.join(packageRoot, 'examples', 'next-monorepo'), root, { recursive: true })

  try {
    const schema = JSON.parse(await readFile(path.join(packageRoot, 'schema', 'iac.schema.json'), 'utf8'))
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')

    const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')
    const manifest = readManifest(manifestPath)
    assert.equal(manifest.apps.length, 2)
    assert.equal(manifest.objectStorage[0].key, 'uploads')
    assert.equal(manifest.databases[0].key, 'appdb')
    assert.equal(manifest.queues[0].key, 'jobs')
    assert.equal(manifest.sandboxes[0].key, 'runner')
    assert.equal(manifest.clusters[0].key, 'workers')

    const syncResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'sync-env',
      '--repo-root',
      root,
      '--variants=staging,production',
    ], packageRoot)

    assert.equal(syncResult.code, 0)
    assert.match(syncResult.stdout, /apps\/web\/\.env\.staging DATABASE_URL/)
    assert.match(syncResult.stdout, /apps\/admin\/\.env\.staging ADMIN_DATABASE_URL/)
    assert.match(syncResult.stdout, /apps\/web\/\.env\.production DATABASE_URL/)
    assert.equal(syncResult.stderr, '')

    const stagingEnv = await readFile(path.join(root, 'apps', 'web', '.env.staging'), 'utf8')
    assert.match(stagingEnv, /^NEXT_PUBLIC_APP_ENV=preview$/m)
    assert.match(stagingEnv, /^DATABASE_URL=postgres:\/\/preview-user/m)
    assert.doesNotMatch(stagingEnv, /^ADMIN_NEXT_PUBLIC_APP_ENV=/m)

    const adminStagingEnv = await readFile(path.join(root, 'apps', 'admin', '.env.staging'), 'utf8')
    assert.match(adminStagingEnv, /^NEXT_PUBLIC_APP_ENV=preview$/m)
    assert.match(adminStagingEnv, /^ADMIN_DATABASE_URL=postgres:\/\/preview-admin/m)

    const envResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'env',
      '--repo-root',
      root,
      '--targets=preview,production',
      '--projects=web,admin',
    ], packageRoot)

    assert.equal(envResult.code, 0)
    assert.match(envResult.stdout, /next-monorepo-web/)
    assert.match(envResult.stdout, /next-monorepo-admin/)
    assert.match(envResult.stdout, /\[team:preview\].*4.*shared keys/)
    assert.equal(envResult.stderr, '')

    const renderResult = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'render',
      '--repo-root',
      root,
      '--target=all',
      '--env=production',
    ], packageRoot)

    assert.equal(renderResult.code, 0)
    assert.equal(renderResult.stderr, '')

    const vercelMain = await readFile(
      path.join(root, '.vertile', 'terraform', 'vercel', 'main.tf'),
      'utf8',
    )
    const awsMain = await readFile(
      path.join(root, '.vertile', 'terraform', 'aws', 'main.tf'),
      'utf8',
    )
    const digitalOceanMain = await readFile(
      path.join(root, '.vertile', 'terraform', 'digitalocean', 'main.tf'),
      'utf8',
    )
    assert.match(vercelMain, /resource "vercel_project" "web"/)
    assert.match(vercelMain, /resource "vercel_project" "admin"/)
    assert.match(vercelMain, /resource "vercel_project_domain" "web_next_monorepo_example_com"/)
    assert.match(vercelMain, /resource "vercel_project_domain" "web_www_next_monorepo_example_com"/)
    assert.match(vercelMain, /resource "vercel_project_environment_variable" "example_escape_hatch"/)
    assert.match(awsMain, /resource "aws_s3_bucket" "object_storage_uploads"/)
    assert.match(awsMain, /resource "aws_db_instance" "database_appdb"/)
    assert.match(awsMain, /resource "aws_sqs_queue" "queue_jobs"/)
    assert.match(awsMain, /resource "aws_instance" "sandbox_runner"/)
    assert.match(awsMain, /resource "aws_instance" "cluster_workers"/)
    assert.match(awsMain, /resource "aws_sns_topic" "events"/)
    assert.match(digitalOceanMain, /resource "digitalocean_spaces_bucket" "object_storage_uploads"/)
    assert.match(digitalOceanMain, /resource "digitalocean_database_cluster" "database_appdb"/)
    assert.match(digitalOceanMain, /resource "digitalocean_droplet" "sandbox_runner"/)
    assert.match(digitalOceanMain, /resource "digitalocean_droplet" "cluster_workers"/)
    assert.match(digitalOceanMain, /resource "digitalocean_project" "main"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
