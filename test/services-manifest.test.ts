// @ts-nocheck
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { normalizeManifest } from '../src/core/manifest.js'

const schema = JSON.parse(readFileSync('schema/iac.schema.json', 'utf8'))

function manifest(overrides = {}) {
  return {
    version: 1,
    project: { name: 'services-sample' },
    environments: ['production'],
    providers: {
      digitalocean: { region: 'nyc3' },
    },
    apps: [{ key: 'web' }],
    ...overrides,
  }
}

function service(overrides = {}) {
  return {
    key: 'api',
    app: 'web',
    runtime: 'container',
    port: 3000,
    healthCheck: { path: '/healthz' },
    providers: {
      digitalocean: {
        mode: 'droplet',
        region: 'sfo3',
        sizeSlug: 's-1vcpu-1gb',
        image: 'ubuntu-24-04-x64',
        backups: true,
        monitoring: false,
        reservedIp: true,
        sshKeyFingerprints: ['SHA256:abc123'],
        managementCidrs: ['203.0.113.10/32', '2001:db8::/48'],
      },
    },
    ...overrides,
  }
}

test('normalizes top-level services with v1 defaults', () => {
  assert.deepEqual(normalizeManifest(manifest()).services, [])

  const normalized = normalizeManifest(manifest({
    services: [service({
      public: undefined,
      replicas: undefined,
      providers: {
        digitalocean: {
          mode: 'droplet',
          managementCidrs: ['203.0.113.10/32'],
        },
      },
    })],
  }))

  assert.deepEqual(normalized.services, [{
    key: 'api',
    app: 'web',
    runtime: 'container',
    port: 3000,
    public: true,
    replicas: 1,
    healthCheck: { path: '/healthz' },
    providers: {
      digitalocean: {
        mode: 'droplet',
        managementCidrs: ['203.0.113.10/32'],
        reservedIp: true,
      },
    },
  }])
})

test('validates service keys and app references', () => {
  assert.throws(
    () => normalizeManifest(manifest({ services: 'api' })),
    /iac\.json services must be an array/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ key: '' })] })),
    /services item must include a non-empty key/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ key: 'api' }), service({ key: 'api' })] })),
    /Duplicate iac\.json services key "api"/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ key: 'web-server' }), service({ key: 'web_server' })] })),
    /services keys "web-server" and "web_server" collide after Terraform name sanitization/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ app: 'missing' })] })),
    /services\.api\.app must reference an apps\[\]\.key/,
  )
})

test('validates service runtime, port, rollout metadata, and unsupported public variants', () => {
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ runtime: 'node' })] })),
    /services\.api\.runtime must be "container"/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ runtime: undefined })] })),
    /services\.api\.runtime must be "container"/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ protocol: 'https' })] })),
    /services\.api\.protocol is not supported/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ port: undefined })] })),
    /services\.api\.port must be an integer from 1 to 65535/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ port: 0 })] })),
    /services\.api\.port must be an integer from 1 to 65535/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ port: 65536 })] })),
    /services\.api\.port must be an integer from 1 to 65535/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ port: '3000' })] })),
    /services\.api\.port must be an integer from 1 to 65535/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ healthCheck: { path: 'healthz' } })] })),
    /services\.api\.healthCheck\.path must be an absolute path beginning with "\/"/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ public: false })] })),
    /services\.api\.public false is not supported/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ replicas: 2 })] })),
    /services\.api\.replicas must be 1/,
  )
})

test('validates DigitalOcean service provider settings', () => {
  assert.throws(
    () => normalizeManifest(manifest({ providers: { digitalocean: { region: '' } }, services: [service()] })),
    /providers\.digitalocean\.region must be a non-empty string/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: 'digitalocean' })] })),
    /services\.api\.providers must be an object/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: 'droplet' } })] })),
    /services\.api\.providers\.digitalocean must be an object/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { mode: 'app-platform' } } })] })),
    /services\.api\.providers\.digitalocean\.mode must be "droplet"/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { reservedIp: false } } })] })),
    /services\.api\.providers\.digitalocean\.reservedIp false is not supported/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { region: '' } } })] })),
    /services\.api\.providers\.digitalocean\.region must be a non-empty string/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { sizeSlug: '' } } })] })),
    /services\.api\.providers\.digitalocean\.sizeSlug must be a non-empty string/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { image: '' } } })] })),
    /services\.api\.providers\.digitalocean\.image must be a non-empty string/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { backups: 'true' } } })] })),
    /services\.api\.providers\.digitalocean\.backups must be a boolean/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { monitoring: 'false' } } })] })),
    /services\.api\.providers\.digitalocean\.monitoring must be a boolean/,
  )
})

test('validates service management access arrays', () => {
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { sshKeyFingerprints: [] } } })] })),
    /services\.api\.providers\.digitalocean\.sshKeyFingerprints must be a non-empty array of unique non-empty strings/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { sshKeyFingerprints: ['one', 'one'] } } })] })),
    /services\.api\.providers\.digitalocean\.sshKeyFingerprints must be a non-empty array of unique non-empty strings/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: [] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must be a non-empty array of unique CIDR strings/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: ['203.0.113.10/32', '203.0.113.10/32'] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must be a non-empty array of unique CIDR strings/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: ['203.0.113.10'] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must contain valid CIDR ranges/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: ['0.0.0.0/0'] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must not include global CIDR ranges/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: ['0.0.0.0/00'] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must not include global CIDR ranges/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: ['203.0.113.10/0'] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must not include global CIDR ranges/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: ['::\/0'] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must not include global CIDR ranges/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: ['::\/00'] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must not include global CIDR ranges/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: ['0:0:0:0:0:0:0:0/0'] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must not include global CIDR ranges/,
  )
  assert.throws(
    () => normalizeManifest(manifest({ services: [service({ providers: { digitalocean: { managementCidrs: ['2001:db8::1/0'] } } })] })),
    /services\.api\.providers\.digitalocean\.managementCidrs must not include global CIDR ranges/,
  )
})

test('documents and tightens management CIDR schema shape', () => {
  const managementCidrs = schema.$defs.digitalOceanServiceProvider.properties.managementCidrs
  assert.match(managementCidrs.description, /semantic IP version, prefix bounds, and global-range checks/)

  const itemSchema = managementCidrs.items
  const allowsByShape = (cidr) => itemSchema.anyOf.some((variant) => new RegExp(variant.pattern).test(cidr))
  const forbiddenPattern = new RegExp(itemSchema.not.pattern)

  assert.equal(allowsByShape('203.0.113.10/32'), true)
  assert.equal(allowsByShape('2001:db8::/48'), true)
  assert.equal(allowsByShape('not-a-cidr'), false)
  assert.equal(allowsByShape('not-a-cidr/999'), false)
  assert.equal(allowsByShape('203.0.113.10/999'), false)
  assert.equal(allowsByShape('2001:db8::/999'), false)
  assert.match('0.0.0.0/0', forbiddenPattern)
  assert.match('0.0.0.0/00', forbiddenPattern)
  assert.match('::/0', forbiddenPattern)
})

test('documents DigitalOcean backend region and state key schema safety patterns', () => {
  assert.deepEqual(
    schema.$defs.digitalOceanBackend.properties.bucket,
    { $ref: '#/$defs/digitalOceanBucketName' },
  )

  const backendRegionPattern = new RegExp(schema.$defs.digitalOceanBackend.properties.region.pattern)
  assert.match('nyc3', backendRegionPattern)
  assert.match('syd1', backendRegionPattern)
  assert.doesNotMatch('https://nyc3.digitaloceanspaces.com', backendRegionPattern)
  assert.doesNotMatch('nyc3/path', backendRegionPattern)
  assert.doesNotMatch('NYC3', backendRegionPattern)
  assert.doesNotMatch('nyc3\n', backendRegionPattern)

  const stateKeyPattern = new RegExp(
    schema.$defs.digitalOceanDeployment.allOf[1].properties.stateKey.pattern,
  )
  assert.match('sample/prod/terraform.tfstate', stateKeyPattern)
  assert.match('sample_prod-1/state.v1.tfstate', stateKeyPattern)
  assert.doesNotMatch('/sample/prod.tfstate', stateKeyPattern)
  assert.doesNotMatch('sample/prod.tfstate/', stateKeyPattern)
  assert.doesNotMatch('./sample/prod.tfstate', stateKeyPattern)
  assert.doesNotMatch('sample//prod.tfstate', stateKeyPattern)
  assert.doesNotMatch('sample/../prod.tfstate', stateKeyPattern)
  assert.doesNotMatch('sample/./prod.tfstate', stateKeyPattern)
  assert.doesNotMatch('sample\\prod.tfstate', stateKeyPattern)
  assert.doesNotMatch('sample prod.tfstate', stateKeyPattern)
  assert.doesNotMatch('sample/\nprod.tfstate', stateKeyPattern)
})

test('does not apply DigitalOcean backend state key rules to other providers', () => {
  assert.doesNotThrow(() => normalizeManifest(manifest({
    providers: {
      digitalocean: { region: 'nyc3' },
      aws: {
        deployments: {
          production: {
            environment: 'production',
            stateKey: 'legacy key owned by another provider',
          },
        },
      },
    },
  })))
})
