// @ts-nocheck
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { readManifest } from '../src/core/manifest.js'
import { resolvePrivateValues } from '../src/core/private-values.js'
import { readVercelToken, resolveIacContext } from '../src/shared.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const secretSentinel = 'private-value-should-never-be-logged'

function execNode(args, cwd = packageRoot) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr })
    })
  })
}

function execNodeWithEnv(args, env, cwd = packageRoot) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd, env }, (error, stdout, stderr) => {
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

async function writeVersionTwoFixture({ privateValues = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-private-values-'))
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'web'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await writeFile(
    path.join(root, '.gitignore'),
    '/.vertile-iac/private.json\npackages/web/.env.*\n',
  )
  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'iac.json'),
    JSON.stringify({
      version: 2,
      project: { name: 'private-values-fixture' },
      environments: ['local', 'production'],
      providers: {},
      packages: [{ key: 'web', directory: 'packages/web' }],
      env: {
        sync: { directOutputs: true },
        metadata: {
          web: {
            variables: [
              {
                key: 'PUBLIC_ORIGIN',
                example: 'http://localhost:3000',
                encrypted: false,
                browser: true,
                packages: ['web'],
                values: {
                  local: 'http://localhost:3000',
                  production: 'https://example.com',
                },
              },
              {
                key: 'DATABASE_URL',
                example: '<DATABASE_URL>',
                encrypted: true,
                browser: false,
                packages: ['web'],
              },
            ],
          },
        },
      },
    }, null, 2) + '\n',
  )

  const initialized = await new Promise((resolve) => {
    execFile('git', ['init', '--quiet'], { cwd: root }, (error) => resolve(!error))
  })
  assert.equal(initialized, true)

  if (privateValues) {
    const privatePath = path.join(root, '.vertile-iac', 'private.json')
    await mkdir(path.dirname(privatePath), { recursive: true })
    await writeFile(privatePath, JSON.stringify(privateValues, null, 2) + '\n')
    await chmod(privatePath, 0o600)
  }

  return root
}

test('version 2 sync-env resolves encrypted metadata values from the default private file', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: {
        web: {
          DATABASE_URL: {
            local: secretSentinel,
            production: `${secretSentinel}-production`,
          },
        },
      },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
    ])

    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
    assert.match(await readFile(path.join(root, 'packages', 'web', '.env.local'), 'utf8'), new RegExp(`DATABASE_URL=${JSON.stringify(secretSentinel)}`))
    assert.match(await readFile(path.join(root, 'packages', 'web', '.env.local'), 'utf8'), /PUBLIC_ORIGIN="http:\/\/localhost:3000"/)
    assert.match(await readFile(path.join(root, 'packages', 'web', '.env.production'), 'utf8'), new RegExp(`DATABASE_URL=${JSON.stringify(`${secretSentinel}-production`)}`))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects encrypted inline values without exposing them', async () => {
  const root = await writeVersionTwoFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.metadata.web.variables[1].values = { local: secretSentinel }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /encrypted.*must not define inline values/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 Terraform rendering is identical with and without private values', async () => {
  const root = await writeVersionTwoFixture()
  const privatePath = path.join(root, '.vertile-iac', 'private.json')

  try {
    const withoutPrivate = await execNode([
      path.join(packageRoot, 'dist', 'src', 'render.js'),
      '--repo-root', root,
      '--target', 'vercel',
      '--env', 'production',
      '--out', '.vertile/without-private',
    ])
    assert.equal(withoutPrivate.code, 0, withoutPrivate.stderr)

    await mkdir(path.dirname(privatePath), { recursive: true })
    await writeFile(privatePath, JSON.stringify({
      version: 1,
      env: { web: { DATABASE_URL: { production: secretSentinel } } },
    }, null, 2) + '\n')
    await chmod(privatePath, 0o600)

    const withPrivate = await execNode([
      path.join(packageRoot, 'dist', 'src', 'render.js'),
      '--repo-root', root,
      '--target', 'vercel',
      '--env', 'production',
      '--out', '.vertile/with-private',
    ])
    assert.equal(withPrivate.code, 0, withPrivate.stderr)

    const renderedWithoutPrivate = await readFile(
      path.join(root, '.vertile', 'without-private', 'vercel', 'main.tf'),
      'utf8',
    )
    const renderedWithPrivate = await readFile(
      path.join(root, '.vertile', 'with-private', 'vercel', 'main.tf'),
      'utf8',
    )
    assert.equal(renderedWithPrivate, renderedWithoutPrivate)
    assert.doesNotMatch(renderedWithPrivate, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects private values for an unknown env metadata source', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: {
        unknown: {
          DATABASE_URL: { local: secretSentinel },
        },
      },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json env\.unknown references unknown source/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects private values for an unknown env metadata variable', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: {
        web: {
          UNDECLARED_SECRET: { local: secretSentinel },
        },
      },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json env\.web\.UNDECLARED_SECRET references unknown variable/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects private values for an unknown environment', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: {
        web: {
          DATABASE_URL: { preview: secretSentinel },
        },
      },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json env\.web\.DATABASE_URL\.preview references unknown environment/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects private values for a non-encrypted metadata variable', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: {
        web: {
          PUBLIC_ORIGIN: { local: secretSentinel },
        },
      },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json env\.web\.PUBLIC_ORIGIN may only provide encrypted variables/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects private provider fields outside the credential allowlist', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: {
        vercel: { region: secretSentinel },
      },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json providers\.vercel\.region is not allowed/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects a private values file tracked by Git', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: { web: { DATABASE_URL: { local: secretSentinel } } },
    },
  })

  try {
    const staged = await execCommand('git', ['add', '--force', '.vertile-iac/private.json'], root)
    assert.equal(staged.code, 0, staged.stderr)

    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private values file is tracked by Git/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects a private values file that Git does not ignore', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: { web: { DATABASE_URL: { local: secretSentinel } } },
    },
  })

  try {
    await writeFile(path.join(root, '.gitignore'), '')

    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private values file is not Git-ignored: \.vertile-iac\/private\.json/i)
    assert.match(result.stderr, /Add "\/.vertile-iac\/private\.json" to \.gitignore/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects a group-readable private values file on POSIX', { skip: process.platform === 'win32' }, async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: { web: { DATABASE_URL: { local: secretSentinel } } },
    },
  })
  const privatePath = path.join(root, '.vertile-iac', 'private.json')

  try {
    await chmod(privatePath, 0o640)

    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private values file must not be readable by group or others/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 validate accepts encrypted metadata resolved from private values', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: {
        web: {
          DATABASE_URL: {
            local: secretSentinel,
            production: `${secretSentinel}-production`,
          },
        },
      },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'validate.js'),
      '--repo-root', root,
    ])

    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Validation passed/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 validate rejects encrypted metadata without a private value', async () => {
  const root = await writeVersionTwoFixture()

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'validate.js'),
      '--repo-root', root,
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /DATABASE_URL.*must define value, values\.default, or values\.local\./)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 sync-env injects private values through the non-direct metadata path', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: {
        web: {
          DATABASE_URL: {
            local: secretSentinel,
            production: `${secretSentinel}-production`,
          },
        },
      },
    },
  })
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.sync = { sharedKey: 'web' }
    for (const variable of manifest.env.metadata.web.variables) delete variable.packages
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
    ])

    assert.equal(result.code, 0, result.stderr)
    assert.match(await readFile(path.join(root, 'packages', 'web', '.env.local'), 'utf8'), new RegExp(`DATABASE_URL=${JSON.stringify(secretSentinel)}`))
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects an unsupported private values file version', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 2,
      env: { web: { DATABASE_URL: { local: secretSentinel } } },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json version must be 1/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects private values fields outside the private document schema', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: { web: { DATABASE_URL: { local: secretSentinel } } },
      region: 'private-region',
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json region is not allowed/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects non-string private env values', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: {
        web: {
          DATABASE_URL: { local: { value: secretSentinel } },
        },
      },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json env\.web\.DATABASE_URL\.local must be a string/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects malformed private env object levels', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: { web: secretSentinel },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json env\.web must be an object/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects private Vercel protection bypass fields outside its allowlist', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: {
        vercel: {
          protectionBypassForAutomation: {
            ensure: { secret: secretSentinel, rotate: true },
          },
        },
      },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json providers\.vercel\.protectionBypassForAutomation\.ensure\.rotate is not allowed/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolved private context exposes public manifest, env values, and process-preferred provider credentials', async () => {
  const privateProviderToken = `${secretSentinel}-provider`
  const processProviderToken = `${secretSentinel}-process`
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: { web: { DATABASE_URL: { local: secretSentinel } } },
      providers: { vercel: { token: privateProviderToken } },
    },
  })

  try {
    const manifest = readManifest(path.join(root, 'infrastructure', 'iac', 'iac.json'))
    const privateValues = resolvePrivateValues({
      manifest,
      repoRoot: root,
      env: { VERCEL_TOKEN: processProviderToken },
    })

    assert.strictEqual(privateValues.publicManifest, manifest)
    assert.equal(privateValues.getEnvValue({ sourceKey: 'web', key: 'DATABASE_URL', environment: 'local' }), secretSentinel)
    assert.equal(privateValues.getProviderCredential({ provider: 'vercel', field: 'token' }), processProviderToken)
    assert.equal(
      resolvePrivateValues({ manifest, repoRoot: root, env: {} })
        .getProviderCredential({ provider: 'vercel', field: 'token' }),
      privateProviderToken,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 readVercelToken uses a private token before the legacy token file', async () => {
  const privateToken = `${secretSentinel}-vercel-token`
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: { vercel: { token: privateToken } },
    },
  })

  try {
    await writeFile(path.join(root, '.vercel.token'), 'legacy-vercel-token\n')
    const context = resolveIacContext(['--repo-root', root])

    assert.equal(readVercelToken(context, { VERCEL_TOKEN: 'process-vercel-token' }), 'process-vercel-token')
    assert.equal(readVercelToken(context, {}), privateToken)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('blank Vercel environment credentials fall through to private, version 1, and token-file values', async () => {
  const privateRoot = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: { vercel: { token: 'private-vercel-token' } },
    },
  })
  const inlineRoot = await writeVersionTwoFixture()
  const fileRoot = await writeVersionTwoFixture()
  const blankEnv = { VERCEL_TOKEN: '  ', VERCEL_API_KEY: '\t' }

  try {
    assert.equal(
      readVercelToken(resolveIacContext(['--repo-root', privateRoot]), blankEnv),
      'private-vercel-token',
    )

    const inlineManifestPath = path.join(inlineRoot, 'infrastructure', 'iac', 'iac.json')
    const inlineManifest = JSON.parse(await readFile(inlineManifestPath, 'utf8'))
    inlineManifest.version = 1
    inlineManifest.providers.vercel = { token: 'inline-vercel-token' }
    await writeFile(inlineManifestPath, JSON.stringify(inlineManifest, null, 2) + '\n')
    assert.equal(
      readVercelToken(resolveIacContext(['--repo-root', inlineRoot]), blankEnv),
      'inline-vercel-token',
    )

    await writeFile(path.join(fileRoot, '.vercel.token'), 'token-file-vercel-token\n')
    assert.equal(
      readVercelToken(resolveIacContext(['--repo-root', fileRoot]), blankEnv),
      'token-file-vercel-token',
    )
  } finally {
    await rm(privateRoot, { recursive: true, force: true })
    await rm(inlineRoot, { recursive: true, force: true })
    await rm(fileRoot, { recursive: true, force: true })
  }
})

test('version 2 Vercel commands enforce private-file safety through the shared resolver seam', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: { vercel: { apiKey: secretSentinel } },
    },
  })

  try {
    await writeFile(path.join(root, '.gitignore'), '')
    for (const command of [
      'provision-env.js',
      'reconcile-project-settings.js',
      'reconcile-project-domains.js',
    ]) {
      const result = await execNodeWithEnv(
        [
          path.join(packageRoot, 'dist', 'src', command),
          '--repo-root', root,
          '--apply',
        ],
        {
          ...process.env,
          VERCEL_TOKEN: 'process-vercel-token',
          VERCEL_API_KEY: '',
        },
      )

      assert.equal(result.code, 1)
      assert.match(result.stderr, /private values file is not Git-ignored: \.vertile-iac\/private\.json/i)
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 GitHub Actions apply uses a private token without exposing it', async () => {
  const privateToken = `${secretSentinel}-github-token`
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: { github: { token: privateToken } },
    },
  })
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')
  const binDir = path.join(root, 'bin')
  const logPath = path.join(root, 'gh-log.jsonl')

  try {
    await mkdir(binDir, { recursive: true })
    const ghPath = path.join(binDir, 'gh')
    await writeFile(
      ghPath,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs')",
        "fs.appendFileSync(process.env.GH_LOG_PATH, JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN || '' }) + '\\n')",
      ].join('\n') + '\n',
    )
    await chmod(ghPath, 0o755)

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.providers.github = {
      repository: 'example/private-values',
      actions: {
        environments: {
          local: { env: ['PUBLIC_ORIGIN'] },
        },
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const result = await execNodeWithEnv(
      [
        path.join(packageRoot, 'dist', 'src', 'github-actions.js'),
        '--repo-root', root,
        '--env=local',
        '--apply',
      ],
      {
        ...process.env,
        GH_LOG_PATH: logPath,
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
    )

    assert.equal(result.code, 0, result.stderr)
    const calls = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.ok(calls.length > 0)
    assert.equal(calls.every((call) => call.token === privateToken), true)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('GitHub Actions apply redacts an environment output when gh --body fails', async () => {
  const root = await writeVersionTwoFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')
  const binDir = path.join(root, 'bin')

  try {
    await mkdir(binDir, { recursive: true })
    const ghPath = path.join(binDir, 'gh')
    await writeFile(
      ghPath,
      [
        '#!/usr/bin/env node',
        "if (process.argv.includes('--body')) {",
        "  process.stderr.write(`body rejected by fake gh: ${process.argv[process.argv.indexOf('--body') + 1]}\\n`)",
        '  process.exit(1)',
        '}',
      ].join('\n') + '\n',
    )
    await chmod(ghPath, 0o755)

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.env.metadata.web.variables[0].values.local = secretSentinel
    manifest.providers.github = {
      repository: 'example/private-values',
      actions: {
        environments: {
          local: {
            env: [{ source: 'PUBLIC_ORIGIN', secret: true }],
          },
        },
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const result = await execNodeWithEnv(
      [
        path.join(packageRoot, 'dist', 'src', 'github-actions.js'),
        '--repo-root', root,
        '--env=local',
        '--apply',
      ],
      {
        ...process.env,
        GH_TOKEN: 'fake-gh-token',
        GITHUB_TOKEN: '',
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
    )

    assert.equal(result.code, 1)
    assert.equal(`${result.stdout}${result.stderr}`.includes(secretSentinel), false)
    assert.match(
      result.stderr,
      /gh secret set PUBLIC_ORIGIN --repo example\/private-values --env local --body \[redacted\] failed with exit code 1/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolved provider context keeps the version 1 githubActions token fallback', async () => {
  const root = await writeVersionTwoFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.version = 1
    manifest.providers.githubActions = { token: 'legacy-github-actions-token' }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const resolved = resolvePrivateValues({
      manifest: readManifest(manifestPath),
      repoRoot: root,
      env: {},
    })

    assert.equal(
      resolved.getProviderCredential({ provider: 'github', field: 'token' }),
      'legacy-github-actions-token',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 projects injects a private bypass secret only into the local Vercel request', async () => {
  const privateToken = `${secretSentinel}-vercel-token`
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: {
        vercel: {
          token: privateToken,
          protectionBypassForAutomation: {
            ensure: { secret: secretSentinel },
          },
        },
      },
    },
  })
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')
  const fetchShimPath = path.join(root, 'fetch-shim.mjs')
  const fetchLogPath = path.join(root, 'fetch-log.jsonl')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.providers.vercel = {
      teamSlug: 'private-values-team',
      protectionBypassForAutomation: {
        ensure: { note: 'Private E2E' },
      },
    }
    manifest.apps = [{ key: 'web', id: 'prj_web', name: 'private-values-web', providers: {} }]
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    assert.equal(
      readManifest(manifestPath).providers.vercel.protectionBypassForAutomation.ensure.secret,
      undefined,
    )

    await writeFile(
      fetchShimPath,
      [
        "import fs from 'node:fs'",
        "globalThis.fetch = async (url, options = {}) => {",
        "  fs.appendFileSync(process.env.FETCH_LOG_PATH, JSON.stringify({ url: String(url), method: options.method || 'GET', authorization: options.headers?.Authorization || '', body: options.body || '' }) + '\\n')",
        "  const pathname = new URL(String(url)).pathname",
        "  if (pathname === '/v1/teams') return Response.json({ teams: [{ id: 'team_private', slug: 'private-values-team' }] })",
        "  if (pathname === '/v9/projects') return Response.json({ projects: [{ id: 'prj_web', name: 'private-values-web' }] })",
        "  if (pathname === '/v9/projects/prj_web') return Response.json({ rootDirectory: null, nodeVersion: null, enableAffectedProjectsDeployments: null, protectionBypass: {} })",
        "  if (pathname === '/v1/projects/prj_web/protection-bypass') return Response.json({ ok: true })",
        "  return new Response(JSON.stringify({ error: `unexpected ${pathname}` }), { status: 500 })",
        "}",
      ].join('\n') + '\n',
    )

    const result = await execNodeWithEnv(
      [
        '--import', fetchShimPath,
        path.join(packageRoot, 'dist', 'src', 'reconcile-project-settings.js'),
        '--repo-root', root,
        '--projects=web',
        '--apply',
      ],
      {
        ...process.env,
        FETCH_LOG_PATH: fetchLogPath,
        VERCEL_TOKEN: '',
        VERCEL_API_KEY: '',
        VERCEL_API_THROTTLE_MS: '0',
      },
    )

    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
    const calls = (await readFile(fetchLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(calls[0].authorization, `Bearer ${privateToken}`)
    const bypassCall = calls.find((call) => new URL(call.url).pathname === '/v1/projects/prj_web/protection-bypass')
    assert.deepEqual(JSON.parse(bypassCall.body), {
      generate: { secret: secretSentinel, note: 'Private E2E' },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 projects redacts a private bypass secret echoed by a Vercel API failure', async () => {
  const escapedSecretSentinel = 'private-value-"quoted"\\path'
  const privateToken = `${secretSentinel}-vercel-token`
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: {
        vercel: {
          token: privateToken,
          protectionBypassForAutomation: {
            ensure: { secret: escapedSecretSentinel },
          },
        },
      },
    },
  })
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')
  const fetchShimPath = path.join(root, 'fetch-shim.mjs')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.providers.vercel = {
      teamSlug: 'private-values-team',
      protectionBypassForAutomation: {
        ensure: { note: 'Private E2E' },
      },
    }
    manifest.apps = [{ key: 'web', id: 'prj_web', name: 'private-values-web', providers: {} }]
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    await writeFile(
      fetchShimPath,
      [
        "globalThis.fetch = async (url, options = {}) => {",
        "  const pathname = new URL(String(url)).pathname",
        "  if (pathname === '/v1/teams') return Response.json({ teams: [{ id: 'team_private', slug: 'private-values-team' }] })",
        "  if (pathname === '/v9/projects') return Response.json({ projects: [{ id: 'prj_web', name: 'private-values-web' }] })",
        "  if (pathname === '/v9/projects/prj_web') return Response.json({ rootDirectory: null, nodeVersion: null, enableAffectedProjectsDeployments: null, protectionBypass: {} })",
        "  if (pathname === '/v1/projects/prj_web/protection-bypass') return new Response(JSON.stringify(JSON.parse(options.body).generate.secret), { status: 400 })",
        "  return new Response(JSON.stringify({ error: `unexpected ${pathname}` }), { status: 500 })",
        "}",
      ].join('\n') + '\n',
    )

    const result = await execNodeWithEnv(
      [
        '--import', fetchShimPath,
        path.join(packageRoot, 'dist', 'src', 'reconcile-project-settings.js'),
        '--repo-root', root,
        '--projects=web',
        '--apply',
      ],
      {
        ...process.env,
        VERCEL_TOKEN: '',
        VERCEL_API_KEY: '',
        VERCEL_API_THROTTLE_MS: '0',
      },
    )

    assert.equal(result.code, 1)
    assert.match(
      result.stderr,
      /Vercel API PATCH \/v1\/projects\/prj_web\/protection-bypass failed \(400\)/,
    )
    const output = `${result.stdout}${result.stderr}`
    assert.equal(output.includes(escapedSecretSentinel), false)
    assert.equal(output.includes(JSON.stringify(escapedSecretSentinel)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 projects hide a private bypass secret in a successful invalid Vercel response', async () => {
  const escapedSecretSentinel = 'private-value-"quoted"\\path'
  const privateToken = `${secretSentinel}-vercel-token`
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: {
        vercel: {
          token: privateToken,
          protectionBypassForAutomation: {
            ensure: { secret: escapedSecretSentinel },
          },
        },
      },
    },
  })
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')
  const fetchShimPath = path.join(root, 'fetch-shim.mjs')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.providers.vercel = {
      teamSlug: 'private-values-team',
      protectionBypassForAutomation: {
        ensure: { note: 'Private E2E' },
      },
    }
    manifest.apps = [{ key: 'web', id: 'prj_web', name: 'private-values-web', providers: {} }]
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    await writeFile(
      fetchShimPath,
      [
        "globalThis.fetch = async (url, options = {}) => {",
        "  const pathname = new URL(String(url)).pathname",
        "  if (pathname === '/v1/teams') return Response.json({ teams: [{ id: 'team_private', slug: 'private-values-team' }] })",
        "  if (pathname === '/v9/projects') return Response.json({ projects: [{ id: 'prj_web', name: 'private-values-web' }] })",
        "  if (pathname === '/v9/projects/prj_web') return Response.json({ rootDirectory: null, nodeVersion: null, enableAffectedProjectsDeployments: null, protectionBypass: {} })",
        "  if (pathname === '/v1/projects/prj_web/protection-bypass') return new Response(`invalid ${JSON.stringify(JSON.parse(options.body).generate.secret)}`, { status: 200 })",
        "  return new Response(JSON.stringify({ error: `unexpected ${pathname}` }), { status: 500 })",
        "}",
      ].join('\n') + '\n',
    )

    const result = await execNodeWithEnv(
      [
        '--import', fetchShimPath,
        path.join(packageRoot, 'dist', 'src', 'reconcile-project-settings.js'),
        '--repo-root', root,
        '--projects=web',
        '--apply',
      ],
      {
        ...process.env,
        VERCEL_TOKEN: '',
        VERCEL_API_KEY: '',
        VERCEL_API_THROTTLE_MS: '0',
      },
    )

    assert.equal(result.code, 1)
    assert.match(
      result.stderr,
      /Vercel API PATCH \/v1\/projects\/prj_web\/protection-bypass returned invalid JSON \(200\)/,
    )
    const output = `${result.stdout}${result.stderr}`
    assert.equal(output.includes(escapedSecretSentinel), false)
    assert.equal(output.includes(JSON.stringify(escapedSecretSentinel)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 projects rejects legacy project-settings bypass secrets before any Vercel request', async () => {
  const root = await writeVersionTwoFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')
  const legacySettingsPath = path.join(root, 'legacy-project-settings.json')
  const fetchShimPath = path.join(root, 'fetch-shim.mjs')
  const operationConfig = {
    ensure: { note: 'Legacy E2E', secret: secretSentinel },
    generate: { secret: secretSentinel },
    update: { secret: secretSentinel },
    revoke: { secret: secretSentinel, regenerate: true },
  }
  const locations = [
    {
      name: 'root',
      configure(protectionBypassForAutomation) {
        return {
          protectionBypassForAutomation,
          projects: [{ key: 'web' }],
        }
      },
    },
    {
      name: 'defaults',
      configure(protectionBypassForAutomation) {
        return {
          defaults: { protectionBypassForAutomation },
          projects: [{ key: 'web' }],
        }
      },
    },
    {
      name: 'projects',
      configure(protectionBypassForAutomation) {
        return {
          projects: [{ key: 'web', protectionBypassForAutomation }],
        }
      },
    },
  ]

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.providers.vercel = { teamSlug: 'private-values-team' }
    manifest.apps = [{ key: 'web', id: 'prj_web', name: 'private-values-web' }]
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    await writeFile(
      fetchShimPath,
      [
        "globalThis.fetch = async (url) => {",
        "  const pathname = new URL(String(url)).pathname",
        "  if (pathname === '/v1/teams') return Response.json({ teams: [{ id: 'team_private', slug: 'private-values-team' }] })",
        "  if (pathname === '/v9/projects') return Response.json({ projects: [{ id: 'prj_web', name: 'private-values-web' }] })",
        "  if (pathname === '/v9/projects/prj_web') return Response.json({ rootDirectory: null, nodeVersion: null, enableAffectedProjectsDeployments: null, protectionBypass: {} })",
        "  if (pathname === '/v1/projects/prj_web/protection-bypass') return Response.json({ ok: true })",
        "  return new Response(JSON.stringify({ error: `unexpected ${pathname}` }), { status: 500 })",
        "}",
      ].join('\n') + '\n',
    )

    for (const location of locations) {
      for (const [operation, config] of Object.entries(operationConfig)) {
        await writeFile(
          legacySettingsPath,
          JSON.stringify(location.configure({ [operation]: config }), null, 2) + '\n',
        )
        const result = await execNodeWithEnv(
          [
            '--import', fetchShimPath,
            path.join(packageRoot, 'dist', 'src', 'reconcile-project-settings.js'),
            '--repo-root', root,
            '--project-settings', legacySettingsPath,
            '--projects=web',
            '--apply',
          ],
          {
            ...process.env,
            VERCEL_TOKEN: 'legacy-project-settings-token',
            VERCEL_API_THROTTLE_MS: '0',
          },
        )

        assert.equal(result.code, 1, `${location.name}.${operation}`)
        assert.match(result.stderr, /legacy project-settings.*secret must be private in version 2/i)
        assert.equal(`${result.stdout}${result.stderr}`.includes(secretSentinel), false)
      }
    }

    const versionOneManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    versionOneManifest.version = 1
    await writeFile(manifestPath, JSON.stringify(versionOneManifest, null, 2) + '\n')
    await writeFile(
      legacySettingsPath,
      JSON.stringify({
        projects: [{
          key: 'web',
          protectionBypassForAutomation: operationConfig.ensure,
        }],
      }, null, 2) + '\n',
    )
    const versionOneResult = await execNodeWithEnv(
      [
        '--import', fetchShimPath,
        path.join(packageRoot, 'dist', 'src', 'reconcile-project-settings.js'),
        '--repo-root', root,
        '--project-settings', legacySettingsPath,
        '--projects=web',
        '--apply',
      ],
      {
        ...process.env,
        VERCEL_TOKEN: 'legacy-project-settings-token',
        VERCEL_API_THROTTLE_MS: '0',
      },
    )
    assert.equal(versionOneResult.code, 0, versionOneResult.stderr)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('published manifest schema permits public version 2 bypass ensure metadata without a secret', async () => {
  const schema = JSON.parse(
    await readFile(path.join(packageRoot, 'schema', 'iac.schema.json'), 'utf8'),
  )
  const required = schema.$defs.vercelProtectionBypassForAutomation.properties.ensure.required

  assert.equal(required.includes('note'), true)
  assert.equal(required.includes('secret'), false)
})

test('published manifest schema keeps encrypted inline env values private in version 2', async () => {
  const schema = JSON.parse(
    await readFile(path.join(packageRoot, 'schema', 'iac.schema.json'), 'utf8'),
  )
  const validate = new Ajv2020({ strict: false }).compile(schema)
  const inlineValues = [
    { value: 'inline-secret' },
    { values: { local: 'inline-secret' } },
  ]
  const manifest = (version, inlineValue, encrypted = true) => ({
    version,
    project: { name: 'schema-validation' },
    providers: {},
    apps: [{ key: 'web' }],
    env: {
      metadata: {
        web: {
          variables: [{
            key: 'DATABASE_URL',
            example: 'postgres://example',
            encrypted,
            browser: false,
            ...inlineValue,
          }],
        },
      },
    },
  })

  for (const inlineValue of inlineValues) {
    assert.equal(validate(manifest(2, inlineValue)), false, JSON.stringify(validate.errors))
    assert.equal(validate(manifest(1, inlineValue)), true, JSON.stringify(validate.errors))
  }

  assert.equal(validate(manifest(2, { value: 'public-value' }, false)), true, JSON.stringify(validate.errors))
})

test('published manifest schema keeps root provider credentials private in version 2', async () => {
  const schema = JSON.parse(
    await readFile(path.join(packageRoot, 'schema', 'iac.schema.json'), 'utf8'),
  )
  const validate = new Ajv2020({ strict: false }).compile(schema)
  const credential = 'schema-private-credential'
  const locations = [
    {
      path: 'providers.vercel.token',
      configure(manifest) {
        manifest.providers.vercel = { token: credential }
      },
    },
    {
      path: 'providers.vercel.apiKey',
      configure(manifest) {
        manifest.providers.vercel = { apiKey: credential }
      },
    },
    {
      path: 'providers.github.token',
      configure(manifest) {
        manifest.providers.github = { token: credential }
      },
    },
    {
      path: 'providers.githubActions.token',
      configure(manifest) {
        manifest.providers.githubActions = { token: credential }
      },
    },
  ]
  const manifest = (version) => ({
    version,
    project: { name: 'schema-validation' },
    providers: {},
    apps: [{ key: 'web' }],
  })

  for (const location of locations) {
    const versionTwo = manifest(2)
    location.configure(versionTwo)
    assert.equal(validate(versionTwo), false, `${location.path}: ${JSON.stringify(validate.errors)}`)

    const versionOne = manifest(1)
    location.configure(versionOne)
    assert.equal(validate(versionOne), true, `${location.path}: ${JSON.stringify(validate.errors)}`)
  }
})

test('published manifest schema keeps provider deployment credentials private in version 2', async () => {
  const schema = JSON.parse(
    await readFile(path.join(packageRoot, 'schema', 'iac.schema.json'), 'utf8'),
  )
  const validate = new Ajv2020({ strict: false }).compile(schema)
  const credential = 'schema-private-credential'
  const providers = ['vercel', 'github', 'githubActions', 'aws', 'digitalocean', 'custom']
  const fields = ['token', 'apiKey']
  const manifest = (version, provider, field) => ({
    version,
    project: { name: 'schema-validation' },
    providers: {
      [provider]: {
        deployments: {
          production: { [field]: credential },
        },
      },
    },
    apps: [{ key: 'web' }],
  })

  for (const provider of providers) {
    for (const field of fields) {
      const versionTwo = manifest(2, provider, field)
      assert.equal(
        validate(versionTwo),
        false,
        `providers.${provider}.deployments.production.${field}: ${JSON.stringify(validate.errors)}`,
      )

      const versionOne = manifest(1, provider, field)
      assert.equal(
        validate(versionOne),
        true,
        `providers.${provider}.deployments.production.${field}: ${JSON.stringify(validate.errors)}`,
      )
    }
  }
})

test('published manifest schema keeps Vercel bypass secrets private in version 2', async () => {
  const schema = JSON.parse(
    await readFile(path.join(packageRoot, 'schema', 'iac.schema.json'), 'utf8'),
  )
  const validate = new Ajv2020({ strict: false }).compile(schema)
  const secret = 'a'.repeat(32)
  const operationConfig = {
    ensure: { note: 'Schema validation', secret },
    generate: { secret },
    update: { secret },
    revoke: { secret, regenerate: true },
  }
  const locations = [
    {
      configure(manifest, protectionBypassForAutomation) {
        manifest.providers.vercel = { protectionBypassForAutomation }
      },
    },
    {
      configure(manifest, protectionBypassForAutomation) {
        manifest.apps = [{ key: 'web', protectionBypassForAutomation }]
      },
    },
    {
      configure(manifest, protectionBypassForAutomation) {
        manifest.apps = [{
          key: 'web',
          providers: { vercel: { protectionBypassForAutomation } },
        }]
      },
    },
  ]
  const manifest = (version) => ({
    version,
    project: { name: 'schema-validation' },
    providers: {},
    apps: [{ key: 'web' }],
  })

  for (const location of locations) {
    for (const [operation, config] of Object.entries(operationConfig)) {
      const value = manifest(2)
      location.configure(value, { [operation]: config })
      assert.equal(validate(value), false, `${operation}: ${JSON.stringify(validate.errors)}`)
    }
  }

  const versionTwoPublicEnsure = manifest(2)
  locations[0].configure(versionTwoPublicEnsure, { ensure: { note: 'Schema validation' } })
  assert.equal(validate(versionTwoPublicEnsure), true, JSON.stringify(validate.errors))

  const versionOneInlineEnsure = manifest(1)
  locations[0].configure(versionOneInlineEnsure, {
    ensure: { note: 'Schema validation', secret },
  })
  assert.equal(validate(versionOneInlineEnsure), true, JSON.stringify(validate.errors))
})

test('version 2 rejects inline provider credentials without exposing them', async () => {
  const root = await writeVersionTwoFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.providers.vercel = { token: secretSentinel }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /iac\.json providers\.vercel\.token must be private in version 2/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects tracked Vercel protection bypass secrets across root and app configs', async () => {
  const operations = ['generate', 'ensure', 'update', 'revoke']
  const locations = [
    {
      path: 'providers.vercel.protectionBypassForAutomation',
      configure(manifest, operation) {
        manifest.providers.vercel = {
          protectionBypassForAutomation: { [operation]: { secret: secretSentinel } },
        }
      },
    },
    {
      path: 'apps.web.protectionBypassForAutomation',
      configure(manifest, operation) {
        manifest.apps = [{
          key: 'web',
          protectionBypassForAutomation: { [operation]: { secret: secretSentinel } },
        }]
      },
    },
    {
      path: 'apps.web.providers.vercel.protectionBypassForAutomation',
      configure(manifest, operation) {
        manifest.apps = [{
          key: 'web',
          providers: {
            vercel: {
              protectionBypassForAutomation: { [operation]: { secret: secretSentinel } },
            },
          },
        }]
      },
    },
  ]

  for (const { path: bypassPath, configure } of locations) {
    for (const operation of operations) {
      const root = await writeVersionTwoFixture({
        privateValues: {
          version: 1,
          env: {
            web: {
              DATABASE_URL: {
                local: secretSentinel,
                production: `${secretSentinel}-production`,
              },
            },
          },
        },
      })
      const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        configure(manifest, operation)
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

        const result = await execNode([
          path.join(packageRoot, 'dist', 'src', 'cli.js'),
          'sync-env',
          '--repo-root', root,
          '--dry-run',
        ])

        assert.equal(result.code, 1, `${bypassPath}.${operation}: ${result.stderr}`)
        assert.ok(
          result.stderr.includes(`iac.json ${bypassPath}.${operation}.secret must be private in version 2.`),
          `${bypassPath}.${operation}: ${result.stderr}`,
        )
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

test('version 2 rejects the legacy GitHub Actions inline token alias', async () => {
  const root = await writeVersionTwoFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.providers.githubActions = { token: secretSentinel }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /iac\.json providers\.githubActions\.token must be private in version 2/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects inline provider deployment credentials', async () => {
  const root = await writeVersionTwoFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.providers.vercel = {
      deployments: { production: { token: secretSentinel } },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /iac\.json providers\.vercel\.deployments\.production\.token must be private in version 2/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 1 keeps inline env values and credentials as compatibility fallbacks', async () => {
  const inlineEnvValue = `${secretSentinel}-v1-env`
  const inlineProviderToken = `${secretSentinel}-v1-token`
  const processProviderToken = `${secretSentinel}-v1-process`
  const root = await writeVersionTwoFixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')

  try {
    const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    rawManifest.version = 1
    rawManifest.providers.vercel = { token: inlineProviderToken }
    rawManifest.env.metadata.web.variables[1].values = {
      local: inlineEnvValue,
      production: `${inlineEnvValue}-production`,
    }
    await writeFile(manifestPath, JSON.stringify(rawManifest, null, 2) + '\n')

    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.match(
      await readFile(path.join(root, 'packages', 'web', '.env.local'), 'utf8'),
      new RegExp(`DATABASE_URL=${JSON.stringify(inlineEnvValue)}`),
    )
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))

    const manifest = readManifest(manifestPath)
    assert.equal(
      resolvePrivateValues({ manifest, repoRoot: root, env: {} })
        .getProviderCredential({ provider: 'vercel', field: 'token' }),
      inlineProviderToken,
    )
    assert.equal(
      resolvePrivateValues({ manifest, repoRoot: root, env: { VERCEL_TOKEN: processProviderToken } })
        .getProviderCredential({ provider: 'vercel', field: 'token' }),
      processProviderToken,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('published schemas declare version 2 manifests and a closed private values document', async () => {
  const manifestSchema = JSON.parse(await readFile(path.join(packageRoot, 'schema', 'iac.schema.json'), 'utf8'))
  const privateSchema = JSON.parse(await readFile(path.join(packageRoot, 'schema', 'iac.private.schema.json'), 'utf8'))

  assert.deepEqual(manifestSchema.properties.version.enum, [1, 2])
  assert.equal(privateSchema.$id, 'https://vertile.ai/schemas/iac.private.schema.json')
  assert.equal(privateSchema.additionalProperties, false)
  assert.equal(privateSchema.properties.version.const, 1)
  assert.equal(privateSchema.properties.providers.additionalProperties, false)
  assert.equal(privateSchema.properties.providers.properties.vercel.additionalProperties, false)
  assert.equal(
    privateSchema.properties.providers.properties.vercel.properties.protectionBypassForAutomation
      .properties.ensure.properties.secret.type,
    'string',
  )
})

test('version 2 rejects non-string private provider credentials', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      providers: { github: { token: { value: secretSentinel } } },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json providers\.github\.token must be a string/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('version 2 rejects a private env variable without an environment object', async () => {
  const root = await writeVersionTwoFixture({
    privateValues: {
      version: 1,
      env: { web: { DATABASE_URL: secretSentinel } },
    },
  })

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'sync-env',
      '--repo-root', root,
      '--dry-run',
    ])

    assert.equal(result.code, 1)
    assert.match(result.stderr, /private\.json env\.web\.DATABASE_URL must be an object/i)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
