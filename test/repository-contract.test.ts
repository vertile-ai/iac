// @ts-nocheck
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providerResourceName } from '../src/core/concepts.js'
import { renderLocals } from '../src/core/hcl.js'
import { normalizeManifest } from '../src/core/manifest.js'

test('repository is the required manifest identity and its repo name drives generated names', () => {
  const manifest = normalizeManifest({
    version: 1,
    repository: 'jazelly/noop',
    environments: ['staging'],
    providers: {},
    apps: [],
  })

  assert.equal(manifest.repository, 'jazelly/noop')
  assert.equal(providerResourceName(manifest, 'staging', { key: 'uploads' }), 'noop_staging_uploads')
  assert.match(renderLocals(manifest, 'staging'), /repository_name = "noop"/)
  assert.throws(
    () => normalizeManifest({
      version: 1,
      repository: 'jazelly/noop',
      project: { name: 'noop' },
      environments: ['staging'],
      providers: {},
      apps: [],
    }),
    /project is not supported/i,
  )
})
