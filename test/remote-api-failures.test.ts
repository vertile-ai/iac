// @ts-nocheck
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { testing as domainTesting } from '../src/reconcile-project-domains.js'
import { testing as settingsTesting } from '../src/reconcile-project-settings.js'
import { testing as provisionTesting } from '../src/provision-env.js'

const vercelRateLimitError = {
  error: {
    code: 'rate_limited',
    message: "The rate limit of 6 exceeded for 'projects'. Try again later",
    limit: { remaining: 0, reset: 1_571_432_075, resetMs: 1_571_432_075_563, total: 6 },
  },
}

const vercelBadRequestError = {
  error: {
    code: 'bad_request',
    message: 'The request body is invalid.',
  },
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function withMockFetch(mock, action) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await action()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('uses Vercel documented 429 payload and retry headers before retrying', async () => {
  const calls = []
  let attempt = 0

  await withMockFetch(async (url, options) => {
    calls.push({ url: String(url), options })
    attempt += 1
    if (attempt === 1) {
      return Response.json(vercelRateLimitError, {
        status: 429,
        headers: { 'retry-after': '0', 'x-ratelimit-remaining': '0' },
      })
    }
    return Response.json({ projects: [] })
  }, async () => {
    const response = await settingsTesting.requestJSON({
      token: 'vercel-token',
      method: 'GET',
      pathname: '/v9/projects',
      query: { teamId: 'team_123', limit: 100 },
    })
    assert.deepEqual(response, { projects: [] })
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://api.vercel.com/v9/projects?teamId=team_123&limit=100')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer vercel-token')
  assert.equal(calls[0].options.headers.Accept, 'application/json')
})

test('preserves documented Vercel API failures across project, domain, and env commands', async () => {
  const requests = [
    {
      request: () => settingsTesting.requestJSON({ token: 'token', method: 'PATCH', pathname: '/v9/projects/prj_missing' }),
      expected: /bad_request.*The request body is invalid/,
    },
    {
      request: () => domainTesting.request({ token: 'token', method: 'GET', pathname: '/v9/projects/prj_missing/domains' }),
      expected: /not_found.*Could not find the Project: prj_missing/,
    },
    {
      request: () => provisionTesting.requestJSON({ token: 'token', method: 'POST', pathname: '/v10/projects/prj_missing/env' }),
      expected: /internal_server_error.*An unexpected internal error occurred/,
    },
  ]
  const responses = [
    Response.json(vercelBadRequestError, { status: 400 }),
    Response.json({ error: { code: 'not_found', message: 'Could not find the Project: prj_missing' } }, { status: 404 }),
    Response.json({ error: { code: 'internal_server_error', message: 'An unexpected internal error occurred' } }, { status: 500 }),
  ]

  let cursor = 0
  await withMockFetch(async () => responses[cursor++], async () => {
    for (const { request, expected } of requests) {
      await assert.rejects(request, expected)
    }
  })
})

test('fails explicitly when Vercel returns non-JSON success data or the request cannot complete', async () => {
  const clients = [
    () => settingsTesting.requestJSON({ token: 'token', method: 'GET', pathname: '/v9/projects/prj_web' }),
    () => domainTesting.request({ token: 'token', method: 'GET', pathname: '/v9/projects/prj_web/domains' }),
    () => provisionTesting.requestJSON({ token: 'token', method: 'GET', pathname: '/v10/projects/prj_web/env' }),
  ]

  for (const request of clients) {
    await withMockFetch(
      async () => new Response('<html>upstream proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      async () => assert.rejects(request, /Vercel API GET .* returned invalid JSON/),
    )
    for (const error of [
      new TypeError('network connection reset'),
      new DOMException('request timed out', 'AbortError'),
    ]) {
      await withMockFetch(
        async () => { throw error },
        async () => assert.rejects(request, new RegExp(`Vercel API GET .* request failed: ${error.message}`)),
      )
    }
  }
})

test('handles Vercel rate-limit reset timestamps and rejects malformed retry metadata safely', () => {
  const reset = String(Math.ceil(Date.now() / 1000) + 1)
  assert.ok(settingsTesting.readRetryAfterMs(new Response('', { headers: { 'x-ratelimit-reset': reset } }), 0) >= 0)
  assert.equal(domainTesting.readRetryAfterMs(new Response('', { headers: { 'retry-after': 'not-a-date' } }), 1), 2000)
  assert.equal(provisionTesting.readRetryAfterMs(new Response('', { headers: { 'retry-after': '0' } }), 2), 0)
})

test('deletes shared Vercel env through documented batch endpoint safely', async () => {
  const calls = []
  await withMockFetch(async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const body = JSON.parse(options.body || '{}')
    if (body.ids.includes('already_deleted')) {
      return Response.json({ error: { code: 'not_found', message: 'Environment variable not found' } }, { status: 404 })
    }
    return Response.json({ ok: true })
  }, async () => {
    await provisionTesting.deleteTeamEnvVars({
      token: 'token',
      teamSlug: 'team',
      envVarIds: [...Array.from({ length: 50 }, (_, index) => `env_${index}`), 'env_50', 'already_deleted'],
    })
  })

  assert.equal(calls.length, 4)
  assert.equal(calls[0].url, 'https://api.vercel.com/v1/env?slug=team')
  assert.equal(calls[0].options.method, 'DELETE')
  assert.deepEqual(JSON.parse(calls[0].options.body), { ids: Array.from({ length: 50 }, (_, index) => `env_${index}`) })
  assert.deepEqual(JSON.parse(calls[1].options.body), { ids: ['env_50', 'already_deleted'] })
  assert.deepEqual(JSON.parse(calls[2].options.body), { ids: ['env_50'] })
  assert.deepEqual(JSON.parse(calls[3].options.body), { ids: ['already_deleted'] })
})

test('treats successful shared env delete failed rows as fail-closed', async () => {
  await withMockFetch(async () => Response.json({
    failed: [
      { id: 'env_forbidden', error: { code: 'forbidden', message: 'Cannot delete env', value: 'leaked-delete-secret' } },
    ],
  }), async () => {
    await assert.rejects(
      () => provisionTesting.deleteTeamEnvVars({
        token: 'token',
        teamSlug: 'team',
        envVarIds: ['env_forbidden'],
      }),
      (error) => {
        assert.match(error.message, /failed delete rows/)
        assert.match(error.message, /forbidden/)
        assert.doesNotMatch(error.message, /leaked-delete-secret/)
        assert.match(error.message, /\[redacted\]/)
        return true
      },
    )
  })
})

test('tolerates successful shared env delete failed rows only when they are not-found', async () => {
  const calls = []
  await withMockFetch(async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return Response.json({
      failed: [
        { id: 'already_deleted', error: { code: 'not_found', message: 'Environment variable not found' } },
      ],
    })
  }, async () => {
    await provisionTesting.deleteTeamEnvVars({
      token: 'token',
      teamSlug: 'team',
      envVarIds: ['env_live', 'already_deleted'],
    })
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].options.body), { ids: ['env_live', 'already_deleted'] })
})

test('redacts secret values from Vercel API failure output', async () => {
  await withMockFetch(async () => Response.json({
    error: {
      code: 'bad_request',
      message: 'The request body is invalid.',
      value: 'super-secret-value',
    },
    value: 'super-secret-value',
  }, { status: 400 }), async () => {
    await assert.rejects(
      () => provisionTesting.requestJSON({ token: 'token', method: 'DELETE', pathname: '/v1/env', query: { slug: 'team' }, body: { ids: ['env'] } }),
      (error) => {
        assert.doesNotMatch(error.message, /super-secret-value/)
        assert.match(error.message, /\[redacted\]/)
        assert.match(error.message, /bad_request/)
        return true
      },
    )
  })
})

test('rejects missing Vercel team and project identifiers rather than continuing with malformed API data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-vercel-identifiers-'))
  const shimPath = path.join(root, 'fetch-shim.mjs')
  const manifest = {
    version: 1,
    project: { name: 'vercel-identifiers' },
    environments: ['production'],
    providers: { vercel: { teamSlug: 'team' } },
    apps: [{ key: 'web', name: 'web', domains: ['web.example.com'] }],
  }
  const run = () => spawnSync(
    process.execPath,
    ['--import', shimPath, 'dist/src/reconcile-project-domains.js', '--repo-root', root, '--apply', '--auto-create-keys=web'],
    { cwd: packageRoot, env: { ...process.env, VERCEL_TOKEN: 'token', VERCEL_API_THROTTLE_MS: '0' }, encoding: 'utf8' },
  )

  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(manifest))
    await writeFile(shimPath, [
      "globalThis.fetch = async () => Response.json({ teams: [{ slug: 'team' }] })",
    ].join('\n'))
    const missingTeamId = run()
    assert.equal(missingTeamId.status, 1)
    assert.match(missingTeamId.stderr, /Unable to resolve team ID for slug "team"/)

    await writeFile(shimPath, [
      "globalThis.fetch = async (url) => {",
      "  const pathname = new URL(String(url)).pathname",
      "  if (pathname === '/v1/teams') return Response.json({ teams: [{ id: 'team_123', slug: 'team' }] })",
      "  if (pathname === '/v9/projects') return Response.json({ projects: [{ name: 'web' }] })",
      "  if (pathname === '/v11/projects') return Response.json({ project: {} })",
      "  return Response.json({ error: { code: 'not_found', message: 'not expected' } }, { status: 404 })",
      "}",
    ].join('\n'))
    const missingProjectId = run()
    assert.equal(missingProjectId.status, 1)
    assert.match(missingProjectId.stderr, /Created Vercel project "web" but no project id was returned/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports unavailable, unauthenticated, and failed GitHub CLI calls with their command context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-github-failure-'))
  const bin = path.join(root, 'bin')
  const manifest = {
    version: 1,
    project: { name: 'github-failures' },
    environments: ['production'],
    providers: {
      github: {
        repository: 'owner/repo',
        actions: { environments: { production: {} } },
      },
    },
    apps: [],
  }
  const run = (env) => spawnSync(
    process.execPath,
    ['dist/src/github-actions.js', '--repo-root', root, '--apply'],
    { cwd: packageRoot, env, encoding: 'utf8' },
  )

  try {
    await mkdir(bin, { recursive: true })
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(manifest))

    const unavailable = run({ ...process.env, PATH: bin, GH_TOKEN: '', GITHUB_TOKEN: '' })
    assert.equal(unavailable.status, 1)
    assert.match(unavailable.stderr, /GitHub CLI is unavailable while running gh --version/)

    const ghPath = path.join(bin, 'gh')
    await writeFile(ghPath, [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2)",
      "if (args[0] === '--version') process.exit(0)",
      "if (args[0] === 'auth') { process.stderr.write('not logged in\\n'); process.exit(1) }",
      "process.exit(0)",
    ].join('\n'))
    await chmod(ghPath, 0o755)
    const unauthenticated = run({ ...process.env, PATH: bin, GH_TOKEN: '', GITHUB_TOKEN: '' })
    assert.equal(unauthenticated.status, 1)
    assert.match(unauthenticated.stderr, /gh auth status failed: not logged in/)

    await writeFile(ghPath, [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2)",
      "if (args[0] === '--version' || args[0] === 'auth') process.exit(0)",
      "if (args[0] === 'api') { process.stderr.write('HTTP 403: Resource not accessible by integration\\n'); process.exit(1) }",
      "process.exit(0)",
    ].join('\n'))
    await chmod(ghPath, 0o755)
    const apiFailure = run({ ...process.env, PATH: bin, GH_TOKEN: '', GITHUB_TOKEN: '' })
    assert.equal(apiFailure.status, 1)
    assert.match(apiFailure.stderr, /gh api --method PUT repos\/owner\/repo\/environments\/production --input - failed: HTTP 403/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
