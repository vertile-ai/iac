// @ts-nocheck
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = path.join(packageRoot, 'dist', 'src', 'cli.js')

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr })
    })
  })
}

test('init creates a repository manifest and private scaffold', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-init-'))
  const home = await mkdtemp(path.join(tmpdir(), 'vertile-iac-home-'))
  try {
    assert.equal((await run('git', ['init', '--quiet'], root)).code, 0)
    assert.equal((await run('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], root)).code, 0)

    const result = await run(
      process.execPath,
      [cli, 'init', '--repo-root', root],
      packageRoot,
      { ...process.env, HOME: home },
    )

    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'iac.json'), 'utf8')), {
      version: 2,
      repository: 'acme/widgets',
      environments: ['local', 'staging', 'production'],
      providers: {},
      apps: [],
    })
    assert.deepEqual(JSON.parse(await readFile(path.join(root, '.iac', 'private.json'), 'utf8')), {
      version: 1,
      env: {},
      providers: {},
    })
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(root, '.iac', 'private.json'))).mode & 0o777, 0o600)
    }
    assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), '/.iac/private.json\n')
    assert.equal(
      (await stat(path.join(home, '.iac', 'repositories', 'github', 'acme', 'widgets'))).isDirectory(),
      true,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('scaffold derives private and home-level roots from an existing manifest without overwriting files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-scaffold-'))
  const home = await mkdtemp(path.join(tmpdir(), 'vertile-iac-home-'))
  try {
    const manifest = `${JSON.stringify({
      version: 2,
      repository: 'acme/existing',
      environments: ['local', 'production'],
      providers: {
        vercel: {},
        digitalocean: {},
        cloudflare: {},
      },
      apps: [],
      env: {
        metadata: {
          api: {
            variables: [
              { key: 'DATABASE_URL', encrypted: true, browser: false },
              { key: 'PUBLIC_ORIGIN', encrypted: false, browser: true },
            ],
          },
        },
      },
      terraform: {
        stacks: {
          api: {
            environments: {
              staging: { variables: {} },
              production: { variables: {} },
            },
          },
        },
      },
    }, null, 2)}\n`
    assert.equal((await run('git', ['init', '--quiet'], root)).code, 0)
    assert.equal((await run('git', ['remote', 'add', 'origin', 'git@github.com:fork/existing.git'], root)).code, 0)
    await writeFile(path.join(root, 'iac.json'), manifest)
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n')

    const first = await run(
      process.execPath,
      [cli, 'scaffold', '--repo-root', root],
      packageRoot,
      { ...process.env, HOME: home },
    )

    assert.equal(first.code, 0, first.stderr)
    assert.equal(await readFile(path.join(root, 'iac.json'), 'utf8'), manifest)
    assert.deepEqual(JSON.parse(await readFile(path.join(root, '.iac', 'private.json'), 'utf8')), {
      version: 1,
      env: {
        api: {
          DATABASE_URL: { local: '', production: '' },
        },
      },
      providers: {
        vercel: { token: '' },
        digitalocean: { token: '' },
        cloudflare: { apiToken: '' },
      },
    })
    assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), 'node_modules\n/.iac/private.json\n')
    for (const environment of ['staging', 'production']) {
      assert.equal((await stat(path.join(
        home,
        '.iac',
        'repositories',
        'github',
        'acme',
        'existing',
        'terraform',
        'api',
        environment,
      ))).isDirectory(), true)
    }

    await writeFile(path.join(root, '.iac', 'private.json'), '{"user":"value"}\n')
    const repeated = await run(
      process.execPath,
      [cli, 'scaffold', '--repo-root', root],
      packageRoot,
      { ...process.env, HOME: home },
    )
    assert.equal(repeated.code, 0, repeated.stderr)
    assert.equal(await readFile(path.join(root, '.iac', 'private.json'), 'utf8'), '{"user":"value"}\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
