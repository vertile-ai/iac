// @ts-nocheck
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hasFlag, parseTargetOption, readOption } from '../src/core/args.js'
import { resolvePlatformContext, targetWorkspace } from '../src/core/context.js'
import { providerDeployments, resolveDeployment } from '../src/core/deployments.js'
import { environmentConfig, environmentFiles, environmentOutputFile } from '../src/core/env-files.js'
import {
  applyEnvMetadata,
  assertBrowserProjectionAllowed,
  envExampleEntries,
  isAllowedInEnv,
  isExcludedFromEnv,
  loadEnvMetadata,
  manifestEnvEntries,
} from '../src/core/env-metadata.js'
import {
  block,
  nestedBlock,
  raw,
  renderGenericResources,
  renderLocals,
  renderOutput,
  renderRequiredProvider,
  renderVariable,
  sanitizeName,
} from '../src/core/hcl.js'
import { assertEnvironment, normalizeManifest, readManifest, validateManifest } from '../src/core/manifest.js'
import { terraformApply, terraformPlan } from '../src/core/terraform.js'
import {
  readVercelEnvManifest,
  readVercelProjectDomainsManifest,
  readVercelProjectSettingsManifest,
  vercelEnvManifestFromIac,
  vercelProjectDomainsFromIac,
  vercelProjectSettingsFromIac,
} from '../src/core/vercel-manifests.js'
import { buildGitHubActionsPlan, githubTokenFromManifest } from '../src/core/github-actions.js'
import { testing as domainTesting } from '../src/reconcile-project-domains.js'
import { testing as settingsTesting } from '../src/reconcile-project-settings.js'
import { testing as provisionTesting } from '../src/provision-env.js'
import { testing as githubActionsTesting } from '../src/github-actions.js'
import { testing as syncTesting } from '../src/sync-env.js'
import { findProjectRoot, readVercelToken, resolveIacContext, sharedOptionsHelp } from '../src/shared.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function runNode(args, cwd = packageRoot, env = process.env) {
  return spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' })
}

function sampleManifest(overrides = {}) {
  return {
    version: 1,
    project: { name: 'sample' },
    environments: ['development', 'staging', 'production'],
    providers: {
      vercel: { team: 'team', deployments: { prod: { environment: 'production', teamId: 'team-id' } } },
      aws: { deployments: { prod: { environment: 'production', profile: 'prod' } } },
    },
    apps: [{ key: 'web', name: 'sample-web', domains: ['web.example.com'] }],
    domains: [{ name: 'api.example.com', app: 'web' }],
    ...overrides,
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-core-'))
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  return root
}

test('covers option, environment, deployment, and HCL edge cases', () => {
  assert.equal(readOption(['--name=value'], '--name'), 'value')
  assert.equal(readOption(['--name', 'value'], '--name'), 'value')
  assert.equal(readOption(['--name'], '--name'), '')
  assert.equal(readOption([], '--name'), '')
  assert.equal(hasFlag(['--yes'], '--yes'), true)
  assert.deepEqual(parseTargetOption([]), ['vercel', 'aws', 'digitalocean'])
  assert.deepEqual(parseTargetOption(['--target=aws,aws, vercel']), ['aws', 'vercel'])
  assert.throws(() => parseTargetOption(['--target=unknown']), /Invalid --target/)

  const envManifest = {
    environmentFiles: {
      custom: '.env.custom',
      array: ['.env.one'],
      shaped: { files: '.env.shaped', outputFile: '.env.output' },
      sourced: { sources: ['.env.source'] },
      filed: { file: '.env.file' },
    },
  }
  assert.deepEqual(environmentConfig(envManifest, 'custom'), { files: ['.env.custom'] })
  assert.deepEqual(environmentConfig(envManifest, 'missing'), {})
  assert.deepEqual(environmentFiles(envManifest, 'array'), ['.env.one'])
  assert.deepEqual(environmentFiles(envManifest, 'shaped'), ['.env.shaped'])
  assert.deepEqual(environmentFiles(envManifest, 'sourced'), ['.env.source'])
  assert.deepEqual(environmentFiles(envManifest, 'filed'), ['.env.file'])
  assert.deepEqual(environmentFiles(envManifest, 'unknown'), ['.env.unknown'])
  assert.equal(environmentOutputFile(envManifest, 'shaped'), '.env.output')
  assert.equal(environmentOutputFile(envManifest, 'local'), '.env.local')

  const manifest = sampleManifest()
  assert.deepEqual(providerDeployments(manifest, 'missing'), {})
  assert.deepEqual(resolveDeployment({ manifest, target: 'missing', environment: 'staging' }), {
    name: '', environment: 'staging', values: {},
  })
  assert.deepEqual(resolveDeployment({ manifest, target: 'aws', environment: 'prod' }), {
    name: 'prod', environment: 'production', values: { environment: 'production', profile: 'prod' },
  })
  assert.throws(
    () => resolveDeployment({ manifest, target: 'aws', environment: 'staging', deploymentName: 'missing' }),
    /Unknown aws deployment/,
  )
  assert.deepEqual(
    resolveDeployment({ manifest: { providers: { aws: {} } }, target: 'aws', environment: 'staging', deploymentName: 'prod' }),
    { name: '', environment: 'staging', values: {} },
  )

  assert.equal(sanitizeName(' Hello--World '), 'hello_world')
  assert.equal(sanitizeName('***'), 'resource')
  assert.match(block('resource', ['x'], { raw: raw('var.value'), skipped: undefined, empty: {}, list: [], value: null }), /raw = var.value/)
  assert.match(block('resource', [], { nested: { 'not-valid': 'value' } }), /"not-valid" = "value"/)
  assert.match(nestedBlock('nested', { values: [1, true, { child: 'x' }] }, 2), /nested/)
  assert.match(renderGenericResources([{ type: 'example', name: 'main', values: { enabled: true } }]), /example/)
  assert.match(renderLocals(manifest, 'staging', { name: 'preview' }), /deployment = "preview"/)
  assert.match(renderLocals(manifest, 'staging'), /project_name/)
  assert.match(renderRequiredProvider('aws', 'hashicorp/aws', '1'), /hashicorp\/aws/)
  assert.match(renderVariable('name', { type: raw('string') }), /variable/)
  assert.match(renderOutput('name', { value: 'value' }), /output/)
})

test('covers command helper edge cases without network side effects', async () => {
  assert.deepEqual(domainTesting.parseArgs(['--apply', '--projects=web,admin', '--reconcile-delete', '--skip-new-domain-verify']), {
    apply: true, projects: ['web', 'admin'], reconcileDelete: true, skipNewDomainVerify: true,
  })
  assert.equal(domainTesting.toQuery({ blank: '', nil: null, keep: 1 }), '?keep=1')
  assert.deepEqual(domainTesting.normalizeDomainConfigs([' A.EXAMPLE.COM ', { name: 'a.example.com', gitBranch: ' next ', verified: false }, {}, null]), [{ name: 'a.example.com', gitBranch: 'next', verified: false }])
  const diff = domainTesting.computeDiff({
    desired: [{ name: 'new' }, { name: 'update', gitBranch: 'next' }, { name: 'verify' }],
    current: [{ name: 'update', gitBranch: 'old' }, { name: 'verify', verified: false }, { name: 'stale' }],
    reconcileDelete: true,
  })
  assert.equal(diff.toAdd.length, 1)
  assert.equal(diff.toUpdate.length, 1)
  assert.equal(diff.toVerify.length, 1)
  assert.equal(diff.toRemove.length, 1)
  assert.equal(domainTesting.domainLabel({ name: 'x', gitBranch: 'main' }), 'x (branch=main)')
  assert.deepEqual(domainTesting.domainCreateBody({ name: 'x', gitBranch: null }), { name: 'x', gitBranch: null })
  assert.deepEqual(domainTesting.domainUpdateBody({ gitBranch: 'next' }), { gitBranch: 'next' })

  assert.deepEqual(settingsTesting.parseArgs(['--apply', '--projects=web,admin']), { apply: true, projects: ['web', 'admin'] })
  assert.equal(settingsTesting.toQuery({ a: 'one', b: undefined }), '?a=one')
  assert.deepEqual(settingsTesting.diffSettings({ rootDirectory: 'old', nodeVersion: null }, { rootDirectory: 'new', nodeVersion: null, enableAffectedProjectsDeployments: true }).patch, { rootDirectory: 'new', enableAffectedProjectsDeployments: true })
  assert.equal(settingsTesting.protectionBypassOperation({ revoke: {} }), 'revoke')
  assert.equal(settingsTesting.protectionBypassSummary({}), 'reconcile Vercel protection bypass for automation')
  assert.equal(settingsTesting.trimString(1), '')
  assert.equal(settingsTesting.automationBypassEntries({ protectionBypass: [] }), null)
  assert.deepEqual(settingsTesting.automationBypassEntries({ protectionBypass: { a: { scope: 'automation-bypass', note: 'x' }, b: {} } }).length, 1)
  assert.throws(() => settingsTesting.resolveProtectionBypassRequest({ project: { protectionBypass: {} }, desired: { ensure: { secret: 'x', note: '' } }, projectKey: 'web' }), /non-empty note/)
  assert.throws(() => settingsTesting.resolveProtectionBypassRequest({ project: { protectionBypass: {} }, desired: { ensure: { secret: '', note: 'x' } }, projectKey: 'web' }), /non-empty secret/)
  assert.throws(() => settingsTesting.resolveProtectionBypassRequest({ project: { protectionBypass: { a: { scope: 'automation-bypass', note: 'x' }, b: { scope: 'automation-bypass', note: 'x' } } }, desired: { ensure: { secret: 's', note: 'x', isEnvVar: true } }, projectKey: 'web' }), /matched 2/)
  assert.deepEqual(settingsTesting.resolveProtectionBypassRequest({ project: { protectionBypass: { a: { scope: 'automation-bypass', note: 'x' } } }, desired: { ensure: { secret: 's', note: 'x', isEnvVar: true } }, projectKey: 'web' }), { update: { secret: 's', note: 'x', isEnvVar: true } })

  assert.deepEqual(provisionTesting.parseArgs(['--apply', '--scope=team', '--targets=development,production', '--projects=web', '--reconcile-delete']), { apply: true, scope: 'team', targets: ['development', 'production'], projects: ['web'], reconcileDelete: true })
  assert.throws(() => provisionTesting.parseArgs(['--scope=bad']), /Invalid --scope/)
  assert.throws(() => provisionTesting.parseArgs(['--targets=bad']), /Invalid target/)
  const fileRoot = await mkdtemp(path.join(tmpdir(), 'env-helper-'))
  try {
    const envFile = path.join(fileRoot, '.env')
    await writeFile(envFile, "# comment\nA=one\nB='two'\nA=updated\nBAD-KEY=x\n")
    assert.deepEqual(provisionTesting.parseEnvFile(envFile), [{ key: 'A', value: 'updated' }, { key: 'B', value: 'two' }])
    assert.deepEqual(provisionTesting.parseEnvFile(path.join(fileRoot, 'missing')), [])
    assert.deepEqual(provisionTesting.mergeEntries([[{ key: 'A', value: 'one' }], [{ key: 'A', value: 'two' }, { key: 'B', value: 'three' }]]), [{ key: 'A', value: 'two' }, { key: 'B', value: 'three' }])
    assert.equal(provisionTesting.targetEnvironment({ targets: { preview: { environment: 'uat' } } }, 'preview'), 'uat')
    assert.equal(provisionTesting.targetIncludes({ target: ['preview'] }, 'preview'), true)
    assert.equal(provisionTesting.targetIncludes({ target: 'production' }, 'preview'), false)
    assert.equal(provisionTesting.toQuery({ blank: '', value: 'x' }), '?value=x')
    assert.deepEqual(provisionTesting.chunkEntries([1, 2, 3], 2), [[1, 2], [3]])
    assert.equal(provisionTesting.vercelEnvType({ encrypted: false }), 'plain')
    assert.equal(provisionTesting.groupEntriesByVercelType([{ encrypted: false }, { encrypted: true }]).length, 2)
    assert.deepEqual(provisionTesting.toVercelCreateEnv({ key: 'KEY', value: 'value' }), { key: 'KEY', value: 'value', comment: 'managed by @vertile-ai/iac provision-env' })
    assert.equal(provisionTesting.isOnlyExistingKeyAndTargetError(new Error('no json')), false)
    assert.equal(provisionTesting.isOnlyExistingKeyAndTargetError(new Error('{"failed":[{"error":{"code":"existing_key_and_target"}}]}')), true)
    assert.equal(provisionTesting.isManagedEnvVar({ comment: 'managed by scripts/vercel/provision-env.js' }), true)
  } finally {
    await rm(fileRoot, { recursive: true, force: true })
  }
})

test('covers Vercel request retries and failure responses', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  try {
    globalThis.fetch = async () => {
      attempts += 1
      if (attempts === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
      return Response.json({ ok: true })
    }
    assert.deepEqual(await settingsTesting.requestJSON({ token: 'x', method: 'GET', pathname: '/test' }), { ok: true })
    assert.equal(attempts, 2)
    attempts = 0
    await domainTesting.request({ token: 'x', method: 'GET', pathname: '/test' })
    assert.equal(attempts, 2)
    attempts = 0
    await provisionTesting.requestJSON({ token: 'x', method: 'GET', pathname: '/test' })
    assert.equal(attempts, 2)
    assert.equal(settingsTesting.readRetryAfterMs(new Response('', { headers: { 'retry-after': 'invalid' } }), 0) > 0, true)
    assert.equal(domainTesting.readRetryAfterMs(new Response('', { headers: { 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 1) } }), 0) >= 0, true)
    assert.equal(provisionTesting.readRetryAfterMs(new Response(''), 1), 2000)
    globalThis.fetch = async () => new Response('bad request', { status: 400 })
    await assert.rejects(() => settingsTesting.requestJSON({ token: 'x', method: 'GET', pathname: '/test' }), /failed \(400\)/)
    await assert.rejects(() => domainTesting.request({ token: 'x', method: 'GET', pathname: '/test' }), /failed \(400\)/)
    await assert.rejects(() => provisionTesting.requestJSON({ token: 'x', method: 'GET', pathname: '/test' }), /failed \(400\)/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('covers GitHub Actions and env sync pure helper branches', () => {
  assert.deepEqual(githubActionsTesting.splitList(' one, ,two '), ['one', 'two'])
  assert.deepEqual(githubActionsTesting.parseArgs(['--apply', '--repo=owner/repo', '--env=staging,production']), {
    apply: true, repo: 'owner/repo', environments: ['staging', 'production'],
  })
  assert.equal(githubActionsTesting.environmentPathName('name with slash/a'), 'name%20with%20slash%2Fa')
  const planOutput = []
  const originalLog = console.log
  console.log = (value = '') => planOutput.push(String(value))
  try {
    githubActionsTesting.printPlan({
      apply: true,
      plan: { repo: 'owner/repo', environments: [{ environment: 'staging', name: 'Staging', branches: ['beta'], outputs: [{ key: 'SECRET', source: 'SOURCE_SECRET', value: 'secret', secret: true }, { key: 'VALUE', source: 'SOURCE_VALUE', value: 'value', secret: false }] }] },
    })
  } finally {
    console.log = originalLog
  }
  assert.equal(planOutput.some((line) => line.includes('Secrets:')), true)
  assert.equal(planOutput.some((line) => line.includes('Variables:')), true)

  assert.equal(syncTesting.hasFlag(['--dry-run'], '--dry-run'), true)
  assert.deepEqual(syncTesting.splitList('one, two,,three'), ['one', 'two', 'three'])
  const variants = syncTesting.configuredVariants({ environmentFiles: { custom: { output: '.env.custom', sources: ['.env.source'], strict: false } } })
  assert.equal(variants.custom.strict, false)
  assert.deepEqual(syncTesting.selectedVariantNames(['--variants=custom'], variants), ['custom'])
  assert.throws(() => syncTesting.selectedVariantNames(['--variants=missing'], variants), /Invalid --variants/)
  assert.deepEqual(syncTesting.parseEnvLine('KEY="value"'), { key: 'KEY', value: 'value' })
  assert.equal(syncTesting.parseEnvLine('BAD-KEY=value'), null)
  assert.equal(syncTesting.parseEnvValue("'quoted'"), 'quoted')
  assert.deepEqual(syncTesting.mergeLayers([[{ key: 'A', value: 'one' }], [{ key: 'A', value: 'two' }, { key: 'B', value: 'three' }]]), [{ key: 'A', value: 'two' }, { key: 'B', value: 'three' }])
  assert.equal(syncTesting.entriesToLines([{ key: 'A', value: 'one' }])[0], 'A="one"')
  assert.equal(syncTesting.ensureTrailingNewline('value'), 'value\n')
  assert.equal(syncTesting.ensureTrailingNewline('value\n'), 'value\n')
  assert.equal(syncTesting.filterEntriesForVariant([{ key: 'A', excludeEnv: ['production'] }, { key: 'B', includeEnv: ['production'], includeEnvConfigured: true }], { required: false }, 'production').length, 2)
  assert.deepEqual(syncTesting.configuredMetadataSourceKeys({ env: { metadata: { sources: { shared: {} }, app: {} } } }), ['app', 'shared'])
  assert.equal(syncTesting.usesDirectOutputs({ env: { sync: { directOutputs: true } } }), true)
  assert.equal(syncTesting.usesDirectOutputs({ env: {} }), false)
  assert.equal(syncTesting.packageRefForPackage({ packages: [{ package: 'web', key: 'OUTPUT' }] }, { key: 'web' }).key, 'OUTPUT')
  assert.equal(syncTesting.valueForMetadataEntry({ entry: { valuesConfigured: true, values: { production: 'value' } }, environment: 'production', metadata: { filePath: 'meta' } }), 'value')
  assert.throws(() => syncTesting.valueForMetadataEntry({ entry: { valuesConfigured: true, values: {} }, environment: 'production', metadata: { filePath: 'meta' } }), /must define value/)
  assert.equal(syncTesting.appExampleOutputPath('/root', { key: 'web', rootDirectory: 'apps/web' }), '/root/apps/web/.env.example')
  assert.equal(syncTesting.appSharedPrefix({ env: { sharedPrefix: 'NEXT_PUBLIC_' } }), 'NEXT_PUBLIC_')
  assert.deepEqual(syncTesting.projectSharedLayer([{ key: 'NEXT_PUBLIC_A', value: 'x' }, { key: 'SECRET', value: 'x' }], { key: 'web', env: { sharedPrefix: 'NEXT_PUBLIC_' } }).map(({ key, value }) => ({ key, value })), [{ key: 'A', value: 'x' }])
  assert.deepEqual(syncTesting.requiredSharedAliases({ env: { sync: { requiredSharedAliases: ['A'] } } }), ['A'])
  assert.throws(() => syncTesting.assertRequiredSharedAliases({ sharedLayer: [{ key: 'A', value: 'x' }], projectedLayer: [], app: { key: 'web', env: { sharedPrefix: 'NEXT_PUBLIC_' } }, requiredAliases: ['A'] }), /projection parity failed/)
  assert.throws(() => syncTesting.assertNoSharedOverrides({ sharedLayer: [{ key: 'A' }], scopedLayer: [{ key: 'A' }], app: { key: 'web' } }), /overrides shared env keys/)
  assert.deepEqual([...syncTesting.linesToEnvMap(['A=one', 'B=two']).entries()], [['A', 'one'], ['B', 'two']])
  assert.deepEqual(syncTesting.diffEnvMaps(new Map([['A', 'old'], ['C', 'gone']]), new Map([['A', 'new'], ['B', 'added']])), [{ type: 'updated', key: 'A' }, { type: 'added', key: 'B' }, { type: 'removed', key: 'C' }])
  assert.equal(syncTesting.normalizePackageConfig('web').rootDirectory, 'web')
  assert.equal(syncTesting.normalizePackageConfig({ name: 'web', dir: 'apps/web' }).rootDirectory, 'apps/web')
  assert.equal(syncTesting.normalizePackageConfig({}), null)
  assert.equal(syncTesting.normalizePackageConfig(null), null)
  assert.equal(syncTesting.manifestPackages({ apps: [{ key: 'web', rootDirectory: 'apps/web' }] }).length, 1)
  assert.equal(syncTesting.syncPackages({ env: { sync: { packages: ['web'] } }, packages: [{ key: 'web', directory: 'apps/web' }, { key: 'api', directory: 'apps/api' }] }).length, 1)
  assert.throws(() => syncTesting.appOutputDir('/root', { key: 'web' }), /Missing directory/)
  assert.equal(syncTesting.appSourceKey({ env: { sourceKey: 'shared' }, key: 'web' }), 'shared')
})

test('covers manifest normalization and Vercel manifest derivation failures', async () => {
  const root = await fixture()
  const manifestPath = path.join(root, 'infrastructure', 'iac', 'iac.json')
  try {
    const normalized = normalizeManifest({
      version: 1,
      project: 'sample',
      environments: {},
      providers: {},
      apps: [],
    })
    assert.deepEqual(normalized.environments, ['development', 'preview', 'production'])
    assert.throws(() => normalizeManifest({ version: 2, project: 'x', environments: [], providers: {} }), /Unsupported/)
    assert.throws(() => validateManifest({ version: 1, project: {}, environments: [], providers: {} }), /project.name/)
    assert.throws(() => validateManifest({ version: 1, project: { name: 'x' }, environments: 'bad', providers: {} }), /array/)
    assert.throws(() => normalizeManifest({ version: 1, project: 'x', environments: [], providers: {}, apps: [{}] }), /app must include a key/)
    assert.throws(() => normalizeManifest({ version: 1, project: 'x', environments: [], providers: {}, queues: [{}] }), /queues item must include a key/)
    assert.throws(() => normalizeManifest({ version: 1, project: 'x', environments: [], providers: { aws: { resources: [{}] } } }), /resources items/)
    assert.throws(() => normalizeManifest({ version: 1, project: 'x', environments: ['production'], providers: { aws: { deployments: { bad: { environment: 'missing' } } } } }), /must be one of/)
    assert.throws(() => assertEnvironment(normalized, 'missing'), /Unknown environment/)
    assert.throws(() => readManifest(path.join(root, 'missing.json')), /Missing required iac manifest/)

    const source = sampleManifest({
      providers: { vercel: { teamSlug: 'slug', projectSettingsDefaults: { nodeVersion: '22.x' }, protectionBypassForAutomation: { ensure: { secret: 'secret', note: 'note' } } } },
      env: {},
      apps: [
        { key: 'web', projectId: 'project', rootDirectory: 'apps/web', providers: { vercel: { protectionBypassForAutomation: false } }, domains: ['web.example.com', { name: 'branch.example.com', gitBranch: 'preview' }] },
        { key: 'skip', deploy: false },
      ],
      domains: [{ name: 'api.example.com', project: 'web' }, { name: 'ignored.example.com' }],
    })
    const env = vercelEnvManifestFromIac(source)
    assert.equal(env.teamSlug, 'slug')
    assert.equal(env.projects.length, 1)
    assert.equal(vercelProjectSettingsFromIac(source).defaults.nodeVersion, '22.x')
    assert.equal(vercelProjectDomainsFromIac(source).projects[0].domains.length, 3)
    assert.throws(() => vercelProjectSettingsFromIac(sampleManifest({ providers: { vercel: { protectionBypassForAutomation: {} } } })), /exactly one/)
    assert.throws(() => vercelProjectSettingsFromIac(sampleManifest({ providers: { vercel: { protectionBypassForAutomation: { ensure: [] } } } })), /must be an object/)

    await writeFile(manifestPath, JSON.stringify(sampleManifest()))
    const context = {
      iacManifestPath: manifestPath,
      projectSettingsPath: path.join(root, 'settings.json'),
      projectDomainsPath: path.join(root, 'domains.json'),
      explicitProjectSettingsPath: false,
      explicitProjectDomainsPath: false,
    }
    assert.equal(readVercelEnvManifest(context).projects[0].key, 'web')
    assert.equal(readVercelProjectSettingsManifest(context).projects[0].key, 'web')
    assert.equal(readVercelProjectDomainsManifest(context).projects[0].key, 'web')
    await writeFile(context.projectSettingsPath, JSON.stringify({ legacy: true }))
    await writeFile(context.projectDomainsPath, JSON.stringify({ legacy: true }))
    assert.deepEqual(readVercelProjectSettingsManifest({ ...context, explicitProjectSettingsPath: true }), { legacy: true })
    assert.deepEqual(readVercelProjectDomainsManifest({ ...context, explicitProjectDomainsPath: true }), { legacy: true })
    assert.throws(() => readVercelEnvManifest({ ...context, iacManifestPath: path.join(root, 'missing-iac.json') }), /Missing required file/)
    assert.throws(() => readVercelProjectSettingsManifest({ ...context, iacManifestPath: path.join(root, 'missing-iac.json'), projectSettingsPath: path.join(root, 'missing-settings.json'), explicitProjectSettingsPath: false }), /Missing required file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('covers env metadata file, embedded, projection, and validation paths', async () => {
  const root = await fixture()
  const baseDir = path.join(root, 'env', 'web')
  const manifest = sampleManifest({ packages: [{ key: 'web' }], env: { metadataFile: 'metadata.json' } })
  try {
    await mkdir(baseDir, { recursive: true })
    assert.equal(loadEnvMetadata({ baseDir, manifest }).required, false)
    assert.deepEqual(envExampleEntries({ baseDir, manifest }), [])
    assert.deepEqual(applyEnvMetadata({ baseDir, manifest, entries: [{ key: 'MISSING', value: 'x' }] })[0], {
      key: 'MISSING', value: 'x', metadata: null, encrypted: true, browser: false,
    })
    assert.equal(manifestEnvEntries({ baseDir, manifest, environment: 'production' }), null)
    assert.throws(() => loadEnvMetadata({ baseDir, manifest, required: true }), /Missing required/)

    const rows = [
      { key: 'SECRET', example: 'example', encrypted: true, browser: false, value: 'fallback', values: { production: 'production' }, includeEnv: ['production'], packages: [{ package: 'web', key: 'WEB_SECRET' }] },
      { key: 'NEXT_PUBLIC_URL', example: 'https://example.com', encrypted: false, browser: true, values: { default: 'https://default.example.com' }, includeInExample: false },
    ]
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify({ variables: rows }))
    const loaded = loadEnvMetadata({ baseDir, manifest })
    assert.equal(loaded.entries.size, 2)
    assert.deepEqual(envExampleEntries({ baseDir, manifest }), [{ key: 'SECRET', value: 'example' }])
    const applied = applyEnvMetadata({ baseDir, manifest, entries: [{ key: 'SECRET', value: 'x' }] })
    assert.equal(applied[0].packages[0].key, 'WEB_SECRET')
    assert.throws(() => applyEnvMetadata({ baseDir, manifest, entries: [{ key: 'UNKNOWN', value: 'x' }] }), /must define metadata/)
    assert.equal(isExcludedFromEnv(applied[0], 'production'), false)
    assert.equal(isAllowedInEnv(applied[0], 'staging'), false)
    assert.equal(isAllowedInEnv(applied[0], 'production'), true)
    const values = manifestEnvEntries({ baseDir, manifest, environment: 'production' })
    assert.equal(values.entries.length, 2)
    assert.equal(values.entries.find((entry) => entry.key === 'SECRET').value, 'production')
    assert.throws(() => assertBrowserProjectionAllowed({ entries: [{ key: 'SERVER_NEXT_PUBLIC_KEY', metadata: {}, browser: false }], prefix: 'SERVER_', metadataPath: 'metadata' }), /browser=false/)
    assert.doesNotThrow(() => assertBrowserProjectionAllowed({ entries: [{ key: 'NEXT_PUBLIC_OK', metadata: {}, browser: true }], prefix: '', metadataPath: 'metadata' }))

    const embeddedManifest = sampleManifest({
      env: { metadata: { sources: { shared: { vars: { EMBEDDED: { example: 'x', encrypted: true, browser: false, value: 'value' } } } } } },
    })
    const embedded = loadEnvMetadata({ baseDir: path.join(root, 'env', 'shared'), manifest: embeddedManifest, sourceKey: 'shared' })
    assert.equal(embedded.filePath, 'iac.json env.metadata.shared')
    assert.equal(manifestEnvEntries({ baseDir, manifest: embeddedManifest, sourceKey: 'shared', environment: 'production' }).entries[0].value, 'value')

    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify({ vars: 'bad' }))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /variables array or vars object/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'BAD-KEY', example: 'x', encrypted: true, browser: false }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /invalid key/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', encrypted: true, browser: false }, { key: 'A', example: 'x', encrypted: true, browser: false }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /duplicate/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify({ variables: { A: { example: 'x', encrypted: true, browser: false } } }))
    assert.equal(loadEnvMetadata({ baseDir, manifest }).entries.has('A'), true)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', encrypted: true, browser: false }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /string example/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', browser: false }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /boolean encrypted/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', encrypted: true }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /boolean browser/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', encrypted: true, browser: false, value: 1 }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /value must be a string/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', encrypted: true, browser: false, values: 'bad' }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /must be an object of string values/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', encrypted: true, browser: false, values: { production: 1 } }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /must be a string/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', encrypted: true, browser: false, packages: null }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /must contain package keys/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', encrypted: true, browser: false, packages: [{ package: '' }] }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /must define non-empty package/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', encrypted: true, browser: false, packages: [{ package: 'missing' }] }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /unknown package/)
    await writeFile(path.join(baseDir, 'metadata.json'), JSON.stringify([{ key: 'A', example: 'x', encrypted: true, browser: false, packages: [{ package: 'web', key: 'bad-key' }] }]))
    assert.throws(() => loadEnvMetadata({ baseDir, manifest }), /invalid output key/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('covers GitHub Actions plan validation and output mapping', async () => {
  const manifest = sampleManifest({
    env: {
      metadata: {
        shared: {
          variables: [
            { key: 'PUBLIC_URL', example: 'x', encrypted: false, browser: false, value: 'https://example.com' },
            { key: 'SECRET', example: 'x', encrypted: true, browser: false, values: { production: 'production-secret', default: 'default-secret' } },
          ],
        },
      },
    },
    providers: {
      github: {
        repository: 'owner/repo',
        token: ' token ',
        actions: {
          variables: 'PUBLIC_URL',
          secrets: ['SECRET'],
          env: [{ from: 'PUBLIC_URL', key: 'RENAMED_URL' }],
          environments: {
            production: { name: 'Production', branch: 'main', env: [{ source: 'SECRET', key: 'RENAMED_SECRET', secret: true }] },
          },
        },
      },
    },
  })
  const plan = buildGitHubActionsPlan({ manifest, sourceRoot: '/unused' })
  assert.equal(githubTokenFromManifest(manifest), 'token')
  assert.equal(plan.repo, 'owner/repo')
  assert.equal(plan.environments[0].branches[0], 'main')
  assert.equal(plan.environments[0].outputs.length, 4)
  assert.equal(buildGitHubActionsPlan({ manifest, sourceRoot: '/unused', selectedEnvironments: ['production'] }).environments.length, 1)
  assert.throws(() => buildGitHubActionsPlan({ manifest, sourceRoot: '/unused', selectedEnvironments: ['missing'] }), /Unknown GitHub Actions environment mapping/)
  assert.throws(() => buildGitHubActionsPlan({ manifest: sampleManifest({ providers: { github: { actions: {} } } }), sourceRoot: '/unused' }), /must define at least one/)
  assert.throws(() => buildGitHubActionsPlan({ manifest: sampleManifest({ providers: { github: { actions: { environments: { missing: {} } } } } }), sourceRoot: '/unused' }), /must match one of/)
  const missingValueManifest = sampleManifest({
    env: manifest.env,
    providers: { github: { actions: { environments: { production: { env: ['MISSING'] } } } } },
  })
  const invalidItemManifest = sampleManifest({
    env: manifest.env,
    providers: { github: { actions: { environments: { production: { env: [{}] } } } } },
  })
  assert.throws(() => buildGitHubActionsPlan({ manifest: missingValueManifest, sourceRoot: '/unused' }), /unknown env metadata key/)
  assert.throws(() => buildGitHubActionsPlan({ manifest: invalidItemManifest, sourceRoot: '/unused' }), /must define source/)
  assert.equal(githubTokenFromManifest({ providers: { githubActions: { token: 'fallback' } } }), 'fallback')
  assert.equal(githubTokenFromManifest({ providers: {} }), '')
})

test('covers context, token precedence, and Terraform error paths', async () => {
  const root = await fixture()
  const oldCwd = process.cwd()
  try {
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(sampleManifest()))
    await writeFile(path.join(root, '.vercel.token'), 'VERCEL_TOKEN=file-token\n')
    const nested = path.join(root, 'nested', 'deeper')
    await mkdir(nested, { recursive: true })
    process.chdir(nested)
    assert.equal(findProjectRoot(nested), root)
    const context = resolveIacContext(['--repo-root', root, '--auto-create-keys=web', '--auto-create-prefixes=api-', '--iac-dir', 'custom', '--token-file', 'token'])
    assert.match(context.iacDir, /custom$/)
    assert.equal(context.shouldAutoCreateProject('web'), true)
    assert.equal(context.shouldAutoCreateProject('api-service'), true)
    assert.equal(context.shouldAutoCreateProject('other'), false)
    assert.equal(resolvePlatformContext(['--repo-root', root, '--out', 'generated', '--terraform-bin', 'tofu']).terraformBin, 'tofu')
    assert.match(targetWorkspace({ generatedRoot: 'generated' }, 'aws', 'prod'), /aws\/prod$/)
    assert.equal(readVercelToken({ iacManifestPath: path.join(root, 'iac.json'), tokenFilePath: path.join(root, '.vercel.token') }, { VERCEL_TOKEN: 'env-token' }), 'env-token')
    assert.equal(readVercelToken({ iacManifestPath: path.join(root, 'iac.json'), tokenFilePath: path.join(root, '.vercel.token') }, {}), 'file-token')
    await writeFile(path.join(root, '.vercel.token'), '# comment\nVERCEL_API_KEY=api-key\n')
    assert.equal(readVercelToken({ iacManifestPath: path.join(root, 'missing.json'), tokenFilePath: path.join(root, '.vercel.token') }, {}), 'api-key')
    assert.throws(() => findProjectRoot(path.join(tmpdir(), 'does-not-exist')), /Could not find project root/)
    assert.match(sharedOptionsHelp(), /--repo-root/)

    const terraform = path.join(root, 'terraform')
    await writeFile(terraform, '#!/bin/sh\ncase "$*" in *fail*) exit 2 ;; *) exit 0 ;; esac\n')
    await chmod(terraform, 0o755)
    terraformPlan({ terraformBin: terraform, workspace: root })
    terraformApply({ terraformBin: terraform, workspace: root, autoApprove: true })
    assert.throws(() => terraformPlan({ terraformBin: path.join(root, 'missing-terraform'), workspace: root }), /Failed to run/)
    const failingTerraform = path.join(root, 'failing-terraform')
    await writeFile(failingTerraform, '#!/bin/sh\nexit 2\n')
    await chmod(failingTerraform, 0o755)
    assert.throws(() => terraformApply({ terraformBin: failingTerraform, workspace: root }), /failed with exit code 2/)
  } finally {
    process.chdir(oldCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('covers CLI help, unknown command, and command dispatch', async () => {
  const cli = path.join(packageRoot, 'dist', 'src', 'cli.js')
  const help = runNode([cli, '--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
  const unknown = runNode([cli, 'unknown'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown command/)
  const noCommand = runNode([cli])
  assert.equal(noCommand.status, 0)
  assert.match(noCommand.stdout, /Commands:/)
})

test('covers command wrapper failures for apply, plan, and render', async () => {
  const root = await fixture()
  try {
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(sampleManifest({ env: {} })))
    const apply = runNode(['dist/src/apply.js', '--repo-root', root, '--target=aws'], packageRoot)
    assert.equal(apply.status, 1)
    assert.match(apply.stderr, /Refusing non-interactive apply/)
    const plan = runNode(['dist/src/plan.js', '--repo-root', root, '--target=aws', '--terraform-bin', path.join(root, 'missing')], packageRoot)
    assert.equal(plan.status, 1)
    assert.match(plan.stderr, /Failed to run/)
    const render = runNode(['dist/src/render.js', '--repo-root', root, '--target=aws', '--env=missing'], packageRoot)
    assert.equal(render.status, 1)
    assert.match(render.stderr, /Unknown environment/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reconciles all Vercel domain change types through a local fetch shim', async () => {
  const root = await fixture()
  const manifestPath = path.join(root, 'iac.json')
  const shimPath = path.join(root, 'fetch-shim.mjs')
  const logPath = path.join(root, 'fetch.jsonl')
  try {
    await writeFile(manifestPath, JSON.stringify(sampleManifest({
      env: {},
      providers: { vercel: { teamSlug: 'team' } },
      apps: [{
        key: 'web', id: 'prj_web', name: 'web',
        domains: [
          'new.example.com',
          { name: 'update.example.com', gitBranch: 'next' },
          'verify.example.com',
        ],
      }],
    })))
    await writeFile(shimPath, [
      "import fs from 'node:fs'",
      "let retried = false",
      "globalThis.fetch = async (url, options = {}) => {",
      "  const parsed = new URL(String(url)); const method = options.method || 'GET'; const pathname = parsed.pathname",
      "  fs.appendFileSync(process.env.FETCH_LOG_PATH, JSON.stringify({ pathname, method, body: options.body || '' }) + '\\n')",
      "  if (pathname === '/v1/teams' && process.env.RETRY_ONCE === '1' && !retried) { retried = true; return new Response('retry', { status: 429, headers: { 'retry-after': '0' } }) }",
      "  if (pathname === '/v1/teams') return Response.json({ teams: [{ id: 'team-id', slug: 'team' }] })",
      "  if (pathname === '/v9/projects') return Response.json({ projects: [{ id: 'prj_web', name: 'web' }] })",
      "  if (pathname === '/v9/projects/prj_web/domains' && method === 'GET') return Response.json({ domains: [",
      "    { name: 'update.example.com', gitBranch: 'old', verified: true },",
      "    { name: 'verify.example.com', verified: false },",
      "    { name: 'orphan.example.com', verified: true }",
      "  ] })",
      "  if (pathname === '/v10/projects/prj_web/domains') return Response.json({ verified: false, verification: [{ type: 'CNAME', domain: 'new.example.com', value: 'target' }] }, { status: 201 })",
      "  if (pathname.includes('/verify')) return Response.json({ error: { message: 'pending' }, verification: [{ type: 'CNAME', domain: 'verify.example.com', value: 'target' }] }, { status: 400 })",
      "  if (method === 'PATCH' || method === 'DELETE') return Response.json({ ok: true })",
      "  return new Response(JSON.stringify({ error: 'unexpected ' + method + ' ' + pathname }), { status: 500 })",
      "}",
    ].join('\n'))
    const result = runNode([
      '--import', shimPath,
      'dist/src/reconcile-project-domains.js',
      '--repo-root', root,
      '--apply',
      '--reconcile-delete',
    ], packageRoot, { ...process.env, VERCEL_TOKEN: 'token', VERCEL_API_THROTTLE_MS: '0', FETCH_LOG_PATH: logPath })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /add: new.example.com/)
    assert.match(result.stdout, /update: update.example.com/)
    assert.match(result.stdout, /verify: verify.example.com/)
    assert.match(result.stdout, /remove: orphan.example.com/)
    const calls = (await (await import('node:fs/promises')).readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.some((call) => call.method === 'PATCH'), true)
    assert.equal(calls.some((call) => call.method === 'DELETE'), true)
    assert.equal(calls.filter((call) => call.pathname.includes('/verify')).length >= 2, true)
    const retry = runNode([
      '--import', shimPath,
      'dist/src/reconcile-project-domains.js',
      '--repo-root', root,
      '--apply',
    ], packageRoot, { ...process.env, VERCEL_TOKEN: 'token', VERCEL_API_THROTTLE_MS: '0', VERCEL_API_MAX_ATTEMPTS: '2', FETCH_LOG_PATH: logPath, RETRY_ONCE: '1' })
    assert.equal(retry.status, 0, retry.stderr)
    assert.match(`${retry.stdout}${retry.stderr}`, /rate-limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('creates an allowed missing Vercel project before reconciling domains', async () => {
  const root = await fixture()
  const shimPath = path.join(root, 'domains-create-shim.mjs')
  try {
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(sampleManifest({
      env: {},
      providers: { vercel: { teamSlug: 'team' } },
      apps: [{ key: 'landing', name: 'landing', domains: ['landing.example.com'] }],
    })))
    await writeFile(shimPath, [
      "globalThis.fetch = async (url, options = {}) => {",
      "  const path = new URL(String(url)).pathname; const method = options.method || 'GET'",
      "  if (path === '/v1/teams') return Response.json({ teams: [{ id: 'team-id', slug: 'team' }] })",
      "  if (path === '/v9/projects') return Response.json({ projects: [] })",
      "  if (path === '/v10/projects') return Response.json({ id: 'prj_landing' })",
      "  if (path === '/v9/projects/prj_landing/domains' && method === 'GET') return Response.json({ domains: [] })",
      "  if (path === '/v10/projects/prj_landing/domains') return Response.json({ verified: true }, { status: 201 })",
      "  return new Response(JSON.stringify({ error: 'unexpected ' + method + ' ' + path }), { status: 500 })",
      "}",
    ].join('\n'))
    const dryRun = runNode(['--import', shimPath, 'dist/src/reconcile-project-domains.js', '--repo-root', root], packageRoot, { ...process.env, VERCEL_TOKEN: 'token', VERCEL_API_THROTTLE_MS: '0' })
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.match(dryRun.stdout, /would create Vercel project "landing"/)
    const apply = runNode(['--import', shimPath, 'dist/src/reconcile-project-domains.js', '--repo-root', root, '--apply'], packageRoot, { ...process.env, VERCEL_TOKEN: 'token', VERCEL_API_THROTTLE_MS: '0' })
    assert.equal(apply.status, 0, apply.stderr)
    assert.match(apply.stdout, /created Vercel project "landing"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('creates missing allowed Vercel projects and reconciles settings', async () => {
  const root = await fixture()
  const manifestPath = path.join(root, 'iac.json')
  const shimPath = path.join(root, 'settings-shim.mjs')
  const logPath = path.join(root, 'settings.jsonl')
  try {
    await writeFile(manifestPath, JSON.stringify(sampleManifest({
      env: {},
      providers: { vercel: { teamSlug: 'team', projectDefaults: { nodeVersion: '22.x', enableAffectedProjectsDeployments: true } } },
      apps: [
        { key: 'landing', name: 'landing', rootDirectory: 'apps/landing' },
        { key: 'web', id: 'prj_web', name: 'web', rootDirectory: 'apps/web', nodeVersion: '24.x' },
      ],
    })))
    await writeFile(shimPath, [
      "import fs from 'node:fs'",
      "globalThis.fetch = async (url, options = {}) => {",
      "  const parsed = new URL(String(url)); const method = options.method || 'GET'; const pathname = parsed.pathname",
      "  fs.appendFileSync(process.env.FETCH_LOG_PATH, JSON.stringify({ pathname, method, body: options.body || '' }) + '\\n')",
      "  if (pathname === '/v1/teams') return Response.json({ teams: [{ id: 'team-id', slug: 'team' }] })",
      "  if (pathname === '/v9/projects' && method === 'GET') return Response.json({ projects: [{ id: 'prj_web', name: 'web' }] })",
      "  if (pathname === '/v10/projects') return Response.json({ project: { id: 'prj_landing' } })",
      "  if (pathname === '/v9/projects/prj_landing' || pathname === '/v9/projects/prj_web') {",
      "    if (method === 'PATCH') return Response.json({ ok: true })",
      "    return Response.json({ rootDirectory: 'old', nodeVersion: '20.x', enableAffectedProjectsDeployments: false })",
      "  }",
      "  return new Response(JSON.stringify({ error: 'unexpected ' + method + ' ' + pathname }), { status: 500 })",
      "}",
    ].join('\n'))
    const result = runNode([
      '--import', shimPath,
      'dist/src/reconcile-project-settings.js',
      '--repo-root', root,
      '--apply',
    ], packageRoot, { ...process.env, VERCEL_TOKEN: 'token', VERCEL_API_THROTTLE_MS: '0', FETCH_LOG_PATH: logPath })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /created Vercel project "landing"/)
    assert.match(result.stdout, /updated remote project settings/)
    const calls = (await (await import('node:fs/promises')).readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.some((call) => call.pathname === '/v10/projects' && call.method === 'POST'), true)
    assert.equal(calls.filter((call) => call.pathname.startsWith('/v9/projects/') && call.method === 'PATCH').length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reconciles shared and project Vercel environment variables with deletes', async () => {
  const root = await fixture()
  const sourceRoot = path.join(root, '.vertile-iac', 'env')
  const shimPath = path.join(root, 'env-shim.mjs')
  const logPath = path.join(root, 'env.jsonl')
  try {
    await mkdir(path.join(sourceRoot, 'shared'), { recursive: true })
    await mkdir(path.join(sourceRoot, 'landing'), { recursive: true })
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(sampleManifest({
      env: { sourceDir: '.vertile-iac/env' },
      environmentFiles: { staging: { files: ['.env.staging'] } },
      providers: { vercel: { teamSlug: 'team' } },
      apps: [{ key: 'landing', name: 'landing' }],
    })))
    await writeFile(path.join(sourceRoot, 'shared', '.env.staging'), 'UPDATE=next\nCREATE=created\n')
    await writeFile(path.join(sourceRoot, 'landing', '.env.staging'), 'PROJECT_VALUE=project\n')
    await writeFile(path.join(sourceRoot, 'shared', '.env.json'), JSON.stringify({ variables: [
      { key: 'UPDATE', example: 'x', encrypted: true, browser: false },
      { key: 'CREATE', example: 'x', encrypted: false, browser: false },
    ] }))
    await writeFile(path.join(sourceRoot, 'landing', '.env.json'), JSON.stringify({ variables: [
      { key: 'PROJECT_VALUE', example: 'x', encrypted: true, browser: false },
    ] }))
    await writeFile(shimPath, [
      "import fs from 'node:fs'",
      "globalThis.fetch = async (url, options = {}) => {",
      "  const parsed = new URL(String(url)); const method = options.method || 'GET'; const pathname = parsed.pathname",
      "  fs.appendFileSync(process.env.FETCH_LOG_PATH, JSON.stringify({ pathname, method, body: options.body || '' }) + '\\n')",
      "  if (pathname === '/v1/teams') return Response.json({ teams: [{ id: 'team-id', slug: 'team' }] })",
      "  if (pathname === '/v9/projects') return Response.json({ projects: [] })",
      "  if (pathname === '/v10/projects') return Response.json({ id: 'prj_landing' })",
      "  if (pathname === '/v1/env' && method === 'GET') return Response.json({ data: [",
      "    { id: 'env_update', key: 'UPDATE', target: ['preview'], comment: 'managed by @vertile-ai/iac provision-env' },",
      "    { id: 'env_stale', key: 'STALE', target: ['preview'], comment: 'managed by @vertile-ai/iac provision-env' }",
      "  ] })",
      "  if (pathname === '/v1/env' && method === 'POST' && process.env.CREATE_CONFLICT === '1') return new Response(JSON.stringify({ failed: [{ error: { code: 'existing_key_and_target' } }] }), { status: 400 })",
      "  if (pathname === '/v1/env' && (method === 'PATCH' || method === 'POST')) return Response.json({ ok: true })",
      "  if (pathname === '/v1/env/env_stale' && method === 'DELETE') return Response.json({ ok: true })",
      "  if (pathname === '/v10/projects/prj_landing/env' && method === 'POST') return Response.json({ ok: true })",
      "  if (pathname === '/v10/projects/prj_landing/env' && method === 'GET') return Response.json({ envs: [{ id: 'project_stale', key: 'STALE_PROJECT', target: ['preview'], comment: 'managed by @vertile-ai/iac provision-env' }] })",
      "  if (pathname === '/v9/projects/prj_landing/env/project_stale' && method === 'DELETE') return Response.json({ ok: true })",
      "  return new Response(JSON.stringify({ error: 'unexpected ' + method + ' ' + pathname }), { status: 500 })",
      "}",
    ].join('\n'))
    const result = runNode([
      '--import', shimPath,
      'dist/src/provision-env.js',
      '--repo-root', root,
      '--targets=preview',
      '--apply',
      '--reconcile-delete',
    ], packageRoot, { ...process.env, VERCEL_TOKEN: 'token', VERCEL_API_THROTTLE_MS: '0', FETCH_LOG_PATH: logPath })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /created Vercel project "landing"/)
    assert.match(result.stdout, /stale managed keys/)
    const calls = (await (await import('node:fs/promises')).readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.some((call) => call.pathname === '/v1/env' && call.method === 'PATCH'), true)
    assert.equal(calls.some((call) => call.pathname === '/v1/env' && call.method === 'POST'), true)
    assert.equal(calls.some((call) => call.pathname === '/v1/env/env_stale' && call.method === 'DELETE'), true)
    assert.equal(calls.some((call) => call.pathname === '/v10/projects/prj_landing/env' && call.method === 'POST'), true)
    assert.equal(calls.some((call) => call.pathname.endsWith('/project_stale') && call.method === 'DELETE'), true)
    const conflict = runNode([
      '--import', shimPath,
      'dist/src/provision-env.js',
      '--repo-root', root,
      '--targets=preview',
      '--apply',
    ], packageRoot, { ...process.env, VERCEL_TOKEN: 'token', VERCEL_API_THROTTLE_MS: '0', FETCH_LOG_PATH: logPath, CREATE_CONFLICT: '1' })
    assert.equal(conflict.status, 0, conflict.stderr)
    assert.match(conflict.stdout, /contained only existing keys; continuing/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validates provision-env command options and required sources', async () => {
  const root = await fixture()
  try {
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(sampleManifest({
      env: { sourceDir: '.vertile-iac/env' },
      providers: { vercel: { teamSlug: 'team' } },
      apps: [{ key: 'web', id: 'prj_web', name: 'web' }],
    })))
    const command = 'dist/src/provision-env.js'
    const invalidScope = runNode([command, '--repo-root', root, '--scope=invalid'], packageRoot)
    assert.equal(invalidScope.status, 1)
    assert.match(invalidScope.stderr, /Invalid --scope/)
    const invalidTarget = runNode([command, '--repo-root', root, '--targets=invalid'], packageRoot)
    assert.equal(invalidTarget.status, 1)
    assert.match(invalidTarget.stderr, /Invalid target/)
    const missingToken = runNode([command, '--repo-root', root, '--apply'], packageRoot, { ...process.env, VERCEL_TOKEN: '', VERCEL_API_KEY: '' })
    assert.equal(missingToken.status, 1)
    assert.match(missingToken.stderr, /Missing VERCEL_TOKEN/)
    const unknownProject = runNode([command, '--repo-root', root, '--projects=missing'], packageRoot)
    assert.equal(unknownProject.status, 1)
    assert.match(unknownProject.stderr, /Unknown project key/)
    const missingFiles = runNode([command, '--repo-root', root, '--reconcile-delete'], packageRoot)
    assert.equal(missingFiles.status, 1)
    assert.match(missingFiles.stderr, /Missing required env source file/)

    await mkdir(path.join(root, '.vertile-iac', 'env', 'shared'), { recursive: true })
    await mkdir(path.join(root, '.vertile-iac', 'env', 'web'), { recursive: true })
    await writeFile(path.join(root, '.vertile-iac', 'env', 'shared', '.env.staging'), '')
    await writeFile(path.join(root, '.vertile-iac', 'env', 'web', '.env.staging'), '')
    const emptyDryRun = runNode([command, '--repo-root', root, '--targets=preview'], packageRoot)
    assert.equal(emptyDryRun.status, 0, emptyDryRun.stderr)
    assert.match(emptyDryRun.stdout, /no keys, skipping/)
    await writeFile(path.join(root, '.vertile-iac', 'env', 'shared', '.env.staging'), 'SHARED=value\n')
    await writeFile(path.join(root, '.vertile-iac', 'env', 'web', '.env.staging'), 'PROJECT=value\n')
    const offlineDelete = runNode([command, '--repo-root', root, '--targets=preview', '--reconcile-delete'], packageRoot)
    assert.equal(offlineDelete.status, 0, offlineDelete.stderr)
    assert.match(offlineDelete.stdout, /cannot compute reconcile deletes without token/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('covers offline Vercel project settings and domain reconciliation paths', async () => {
  const root = await fixture()
  try {
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(sampleManifest({
      env: {},
      providers: { vercel: { teamSlug: 'team', protectionBypassForAutomation: { generate: { secret: 'secret' } } } },
      apps: [{ key: 'web', id: 'prj_web', name: 'web', rootDirectory: 'apps/web', domains: ['web.example.com'] }],
    })))
    const settings = runNode(['dist/src/reconcile-project-settings.js', '--repo-root', root], packageRoot)
    assert.equal(settings.status, 0, settings.stderr)
    assert.match(settings.stdout, /cannot fetch remote settings without token/)
    assert.match(settings.stdout, /cannot resolve generate Vercel protection bypass/)
    const domains = runNode(['dist/src/reconcile-project-domains.js', '--repo-root', root], packageRoot)
    assert.equal(domains.status, 0, domains.stderr)
    assert.match(domains.stdout, /cannot fetch remote domains without token/)
    const settingsApply = runNode(['dist/src/reconcile-project-settings.js', '--repo-root', root, '--apply'], packageRoot, { ...process.env, VERCEL_TOKEN: '' })
    assert.equal(settingsApply.status, 1)
    assert.match(settingsApply.stderr, /Missing VERCEL_TOKEN/)
    const domainsApply = runNode(['dist/src/reconcile-project-domains.js', '--repo-root', root, '--apply'], packageRoot, { ...process.env, VERCEL_TOKEN: '' })
    assert.equal(domainsApply.status, 1)
    assert.match(domainsApply.stderr, /Missing VERCEL_TOKEN/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applies GitHub environment sync through authenticated CLI fallback', async () => {
  const root = await fixture()
  const bin = path.join(root, 'bin')
  const logPath = path.join(root, 'gh.jsonl')
  try {
    await mkdir(bin, { recursive: true })
    await mkdir(path.join(root, '.vertile-iac', 'env', 'shared'), { recursive: true })
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(sampleManifest({
      env: {
        sourceDir: '.vertile-iac/env',
        metadata: { shared: { variables: [
          { key: 'VALUE', example: 'x', encrypted: false, browser: false, value: 'value' },
          { key: 'SECRET', example: 'x', encrypted: true, browser: false, value: 'secret' },
        ] } },
      },
      providers: {
        github: {
          repository: 'owner/repo',
          actions: {
            environments: {
              production: { branches: ['main', 'release'], env: ['VALUE', 'SECRET'] },
            },
          },
        },
      },
    })))
    await writeFile(path.join(bin, 'gh'), [
      '#!/usr/bin/env node',
      "import fs from 'node:fs'",
      "const args = process.argv.slice(2)",
      "fs.appendFileSync(process.env.GH_LOG_PATH, JSON.stringify({ args, input: fs.readFileSync(0, 'utf8') }) + '\\n')",
      "if (args[0] === 'api' && args.at(-1)?.includes('deployment-branch-policies')) process.stdout.write(JSON.stringify({ branch_policies: [{ name: 'main' }] }))",
    ].join('\n'))
    await chmod(path.join(bin, 'gh'), 0o755)
    const result = runNode(['dist/src/github-actions.js', '--repo-root', root, '--apply'], packageRoot, {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_LOG_PATH: logPath, GH_TOKEN: '', GITHUB_TOKEN: '',
    })
    assert.equal(result.status, 0, result.stderr)
    const calls = (await (await import('node:fs/promises')).readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.some((call) => call.args[0] === 'auth' && call.args[1] === 'status'), true)
    assert.equal(calls.some((call) => call.args.includes('name=release')), true)
    assert.equal(calls.some((call) => call.args[0] === 'variable' && call.args[1] === 'set'), true)
    assert.equal(calls.some((call) => call.args[0] === 'secret' && call.args[1] === 'set'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports GitHub Actions configuration failures', async () => {
  const root = await fixture()
  try {
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(sampleManifest({
      env: {},
      providers: { github: { actions: { environments: { production: { env: [] } } } } },
    })))
    const missingRepo = runNode(['dist/src/github-actions.js', '--repo-root', root], packageRoot)
    assert.equal(missingRepo.status, 1)
    assert.match(missingRepo.stderr, /GitHub repository must be configured/)
    const unknownEnvironment = runNode(['dist/src/github-actions.js', '--repo-root', root, '--repo=owner/repo', '--env=missing'], packageRoot)
    assert.equal(unknownEnvironment.status, 1)
    assert.match(unknownEnvironment.stderr, /Unknown GitHub Actions environment mapping/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports add, update, remove, and skip paths during env sync', async () => {
  const root = await fixture()
  const sourceRoot = path.join(root, '.vertile-iac', 'env')
  const outputPath = path.join(root, 'apps', 'web', '.env.staging')
  try {
    await mkdir(path.join(sourceRoot, 'shared'), { recursive: true })
    await mkdir(path.join(sourceRoot, 'web'), { recursive: true })
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(path.join(sourceRoot, 'shared', '.env.staging'), 'SHARED=new\n')
    await writeFile(path.join(sourceRoot, 'web', '.env.staging'), 'UPDATED=new\nADDED=value\n')
    await writeFile(outputPath, 'SHARED=old\nUPDATED=old\nREMOVED=value\n')
    await writeFile(path.join(root, 'iac.json'), JSON.stringify(sampleManifest({
      env: { sourceDir: '.vertile-iac/env', sync: { packages: ['web'] } },
      packages: [{ key: 'web', directory: 'apps/web' }],
      apps: [{ key: 'web', name: 'web', rootDirectory: 'apps/web' }],
      environmentFiles: { staging: { files: ['.env.staging'] } },
    })))
    const dryRun = runNode(['dist/src/sync-env.js', '--repo-root', root, '--variants=staging', '--dry-run'], packageRoot)
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.match(dryRun.stdout, /Would add .*ADDED/)
    assert.match(dryRun.stdout, /Would update .*SHARED/)
    assert.match(dryRun.stdout, /Would remove .*REMOVED/)
    const applied = runNode(['dist/src/sync-env.js', '--repo-root', root, '--variants=staging'], packageRoot)
    assert.equal(applied.status, 0, applied.stderr)
    assert.match(applied.stdout, /Added .*ADDED/)
    const skipped = runNode(['dist/src/sync-env.js', '--repo-root', root], packageRoot, { ...process.env, VERCEL: '1' })
    assert.equal(skipped.status, 0, skipped.stderr)
    assert.match(skipped.stdout, /Skipping infrastructure env sync/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
