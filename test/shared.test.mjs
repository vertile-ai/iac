import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readManifest } from '../src/core/manifest.mjs'
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
        infraDir: 'infrastructure',
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

    assert.equal(result.code, 0)
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

test('published Dynomic example exercises Vercel env and render flows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-dynomic-'))
  await cp(path.join(packageRoot, 'examples', 'dynomic'), root, { recursive: true })

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
    assert.match(envResult.stdout, /dynomic-web/)
    assert.match(envResult.stdout, /dynomic-admin/)
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
    assert.match(vercelMain, /resource "vercel_project_domain" "web_dynomic_example_com"/)
    assert.match(vercelMain, /resource "vercel_project_domain" "web_www_dynomic_example_com"/)
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
