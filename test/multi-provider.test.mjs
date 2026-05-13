import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolvePlatformContext } from '../src/core/context.mjs'
import { readManifest } from '../src/core/manifest.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jazelly-iac-'))
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'iac.json'),
    JSON.stringify(
      {
        version: 1,
        project: { name: 'example' },
        environments: ['preview', 'production'],
        providers: {
          vercel: { team: 'example-team' },
          aws: {
            region: 'us-east-1',
            resources: [
              {
                type: 'aws_s3_bucket',
                name: 'assets',
                values: { bucket: 'example-assets' },
              },
            ],
          },
          digitalocean: {
            resources: [
              {
                type: 'digitalocean_project',
                name: 'main',
                values: { name: 'example' },
              },
            ],
          },
        },
        apps: [
          {
            key: 'web',
            name: 'example-web',
            framework: 'nextjs',
            rootDirectory: 'apps/web',
            domains: ['web.example.com'],
          },
        ],
        domains: [{ name: 'www.example.com', app: 'web' }],
        objectStorage: [{ key: 'uploads', visibility: 'private' }],
        databases: [{ key: 'appdb', engine: 'postgres' }],
        queues: [{ key: 'jobs' }],
        sandboxes: [{ key: 'runner' }],
        clusters: [{ key: 'workers', size: 2 }],
      },
      null,
      2,
    ) + '\n',
  )

  return root
}

function execNode(args, cwd, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd, env: options.env }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout,
        stderr,
      })
    })
  })
}

test('resolves and reads the neutral iac.json manifest', async () => {
  const root = await createFixture()

  try {
    const context = resolvePlatformContext(['--repo-root', root])
    assert.equal(context.manifestPath, path.join(root, 'infrastructure', 'iac', 'iac.json'))

    const manifest = readManifest(context.manifestPath)
    assert.equal(manifest.project.name, 'example')
    assert.deepEqual(manifest.environments, ['preview', 'production'])
    assert.equal(manifest.apps[0].name, 'example-web')
    assert.equal(manifest.objectStorage[0].key, 'uploads')
    assert.equal(manifest.databases[0].key, 'appdb')
    assert.equal(manifest.queues[0].key, 'jobs')
    assert.equal(manifest.sandboxes[0].key, 'runner')
    assert.equal(manifest.clusters[0].key, 'workers')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validates malformed provider escape hatch resources', async () => {
  const root = await createFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        project: { name: 'bad' },
        environments: ['production'],
        providers: {
          aws: {
            resources: [{ type: 'aws_s3_bucket' }],
          },
        },
      }) + '\n',
    )

    assert.throws(
      () => readManifest(manifestPath),
      /providers\.aws\.resources items must include type and name/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renders deterministic Terraform files for each provider', async () => {
  const root = await createFixture()

  try {
    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'render',
      '--repo-root',
      root,
      '--target=all',
      '--env=production',
    ], packageRoot)

    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /vercel/)
    assert.match(result.stdout, /aws/)
    assert.match(result.stdout, /digitalocean/)

    const vercelMain = await readFile(path.join(root, '.jazelly', 'terraform', 'vercel', 'main.tf'), 'utf8')
    const awsMain = await readFile(path.join(root, '.jazelly', 'terraform', 'aws', 'main.tf'), 'utf8')
    const digitalOceanMain = await readFile(path.join(root, '.jazelly', 'terraform', 'digitalocean', 'main.tf'), 'utf8')

    assert.match(vercelMain, /resource "vercel_project" "web"/)
    assert.match(vercelMain, /resource "vercel_project_domain" "web_web_example_com"/)
    assert.match(awsMain, /provider "aws"/)
    assert.match(awsMain, /resource "aws_s3_bucket" "assets"/)
    assert.match(awsMain, /resource "aws_s3_bucket" "object_storage_uploads"/)
    assert.match(awsMain, /resource "aws_db_instance" "database_appdb"/)
    assert.match(awsMain, /resource "aws_sqs_queue" "queue_jobs"/)
    assert.match(awsMain, /resource "aws_instance" "sandbox_runner"/)
    assert.match(awsMain, /resource "aws_instance" "cluster_workers"/)
    assert.match(digitalOceanMain, /provider "digitalocean"/)
    assert.match(digitalOceanMain, /resource "digitalocean_spaces_bucket" "object_storage_uploads"/)
    assert.match(digitalOceanMain, /resource "digitalocean_database_cluster" "database_appdb"/)
    assert.match(digitalOceanMain, /resource "digitalocean_droplet" "sandbox_runner"/)
    assert.match(digitalOceanMain, /resource "digitalocean_droplet" "cluster_workers"/)
    assert.match(digitalOceanMain, /resource "digitalocean_project" "main"/)

    const awsVariables = await readFile(path.join(root, '.jazelly', 'terraform', 'aws', 'variables.tf'), 'utf8')
    assert.match(awsVariables, /variable "database_appdb_password"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runs apply through a mocked Terraform executable with explicit approval', async () => {
  const root = await createFixture()
  const logPath = path.join(root, 'terraform-apply.log')
  const terraformBin = path.join(root, 'terraform-mock')
  await writeFile(
    terraformBin,
    '#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*" >> "$TERRAFORM_LOG"\n',
  )
  await chmod(terraformBin, 0o755)

  try {
    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'apply',
      '--repo-root',
      root,
      '--target=digitalocean',
      '--env=production',
      '--terraform-bin',
      terraformBin,
      '--yes',
    ], packageRoot, {
      env: { ...process.env, TERRAFORM_LOG: logPath },
    })

    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /Applying .*digitalocean/)

    const log = await readFile(logPath, 'utf8')
    assert.match(log, /\.jazelly\/terraform\/digitalocean\|init -input=false/)
    assert.match(log, /\.jazelly\/terraform\/digitalocean\|apply -input=false -auto-approve/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runs plan through a mocked Terraform executable', async () => {
  const root = await createFixture()
  const logPath = path.join(root, 'terraform.log')
  const terraformBin = path.join(root, 'terraform-mock')
  await writeFile(
    terraformBin,
    '#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*" >> "$TERRAFORM_LOG"\n',
  )
  await chmod(terraformBin, 0o755)

  try {
    const result = await execNode([
      path.join(packageRoot, 'src', 'cli.mjs'),
      'plan',
      '--repo-root',
      root,
      '--target=aws',
      '--env=production',
      '--terraform-bin',
      terraformBin,
    ], packageRoot, {
      env: { ...process.env, TERRAFORM_LOG: logPath },
    })

    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /Planning .*aws/)

    const log = await readFile(logPath, 'utf8')
    assert.match(log, /\.jazelly\/terraform\/aws\|init -input=false/)
    assert.match(log, /\.jazelly\/terraform\/aws\|plan -input=false/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
