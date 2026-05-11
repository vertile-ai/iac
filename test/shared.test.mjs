import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveIacContext } from '../src/shared.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jazelly-iac-'))
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
    assert.equal(context.shouldAutoCreateProject('app'), true)
    assert.equal(context.shouldAutoCreateProject('template-demo'), true)
    assert.equal(context.shouldAutoCreateProject('other'), false)
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
