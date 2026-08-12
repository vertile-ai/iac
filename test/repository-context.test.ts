// @ts-nocheck
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cliPath = path.join(packageRoot, 'dist', 'src', 'cli.js')

function execNode(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, options, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr })
    })
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => error ? reject(error) : resolve())
  })
}

async function createRepository({ remote } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-context-'))
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await writeFile(path.join(root, '.gitignore'), '/.iac/private.json\n')
  await mkdir(path.join(root, '.iac'), { recursive: true })
  await writeFile(path.join(root, '.iac', 'private.json'), '{"version":1,"secret":"must-not-be-read"}\n')
  await chmod(path.join(root, '.iac', 'private.json'), 0o600)
  await run('git', ['init', '--quiet'], { cwd: root })
  if (remote) await run('git', ['remote', 'add', 'origin', remote], { cwd: root })
  return root
}

test('context uses the GitHub owner and repo as canonical identity, never project.name', async () => {
  const root = await createRepository({ remote: 'git@github.com:acme/widget.git' })
  const home = await mkdtemp(path.join(tmpdir(), 'vertile-iac-home-'))

  try {
    const result = await execNode([
      cliPath,
      'context',
      '--repo-root', root,
      '--stack', 'platform',
      '--environment', 'staging',
    ], { cwd: packageRoot, env: { ...process.env, HOME: home } })

    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      repository: { kind: 'github', owner: 'acme', repo: 'widget' },
      privateValuesRef: path.join(root, '.iac', 'private.json'),
      terraformStateDirectory: path.join(home, '.iac', 'repositories', 'github', 'acme', 'widget', 'terraform', 'platform', 'staging'),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('context falls back to local GitHub-user and repository-folder identity outside GitHub', async () => {
  const root = await createRepository()
  const home = await mkdtemp(path.join(tmpdir(), 'vertile-iac-home-'))
  const bin = await mkdtemp(path.join(tmpdir(), 'vertile-iac-bin-'))
  const ghPath = path.join(bin, 'gh')
  await writeFile(ghPath, '#!/bin/sh\nprintf local-user\n')
  await chmod(ghPath, 0o755)

  try {
    const result = await execNode([
      cliPath,
      'context',
      '--repo-root', root,
      '--stack', 'platform',
      '--environment', 'production',
    ], {
      cwd: packageRoot,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    })

    assert.equal(result.code, 0, result.stderr)
    const context = JSON.parse(result.stdout)
    assert.deepEqual(context.repository, {
      kind: 'local',
      user: 'local-user',
      repo: path.basename(root),
    })
    assert.equal(
      context.terraformStateDirectory,
      path.join(home, '.iac', 'repositories', 'local', 'local-user', path.basename(root), 'terraform', 'platform', 'production'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  }
})

test('context returns the private file only as a reference and writes nothing to the project', async () => {
  const root = await createRepository({ remote: 'https://github.com/acme/widget.git' })
  const home = await mkdtemp(path.join(tmpdir(), 'vertile-iac-home-'))

  try {
    const before = await readdir(root, { recursive: true })
    const result = await execNode([
      cliPath,
      'context',
      '--repo-root', root,
      '--stack', 'platform',
      '--environment', 'staging',
    ], { cwd: packageRoot, env: { ...process.env, HOME: home } })
    const after = await readdir(root, { recursive: true })

    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).privateValuesRef, path.join(root, '.iac', 'private.json'))
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /must-not-be-read/)
    assert.deepEqual(after.sort(), before.sort())
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('context rejects stack and environment path traversal', async () => {
  const root = await createRepository({ remote: 'https://github.com/acme/widget.git' })

  try {
    for (const args of [
      ['--stack', '../platform', '--environment', 'staging'],
      ['--stack', 'platform/state', '--environment', 'staging'],
      ['--stack', 'platform', '--environment', '..'],
    ]) {
      const result = await execNode([cliPath, 'context', '--repo-root', root, ...args], { cwd: packageRoot })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /safe single path segment/i)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
