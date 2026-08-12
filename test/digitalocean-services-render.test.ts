// @ts-nocheck
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { hclBlock, heredoc, raw, block } from '../src/core/hcl.js'
import { normalizeManifest } from '../src/core/manifest.js'
import { renderTerraform } from '../src/providers/digitalocean/index.js'
import { writeTarget } from '../src/core/render.js'

function manifest(overrides = {}) {
  return normalizeManifest({
    version: 1,
    project: { name: 'svc-sample' },
    environments: ['production', 'uat'],
    providers: {
      digitalocean: {
        region: 'nyc3',
        deployments: {
          uat: { environment: 'uat', region: 'sfo3' },
        },
      },
    },
    apps: [{ key: 'web' }],
    services: [
      {
        key: 'api-service',
        app: 'web',
        runtime: 'container',
        port: 3000,
        healthCheck: { path: '/healthz' },
        providers: {
          digitalocean: {
            region: 'ams3',
            sshKeyFingerprints: ['SHA256:abc123'],
            managementCidrs: ['203.0.113.10/32', '2001:db8::/48'],
          },
        },
      },
    ],
    ...overrides,
  })
}

test('HCL primitives support trusted raw, heredoc, and repeated nested blocks without manifest raw forging', () => {
  const rendered = block('resource', ['example_resource', 'main'], {
    trusted: raw('var.trusted'),
    script: heredoc('line one\nline two'),
    forged: { __raw: true, value: 'var.forged' },
    inbound_rule: [
      hclBlock('inbound_rule', { port_range: '80' }),
      hclBlock('inbound_rule', { port_range: '443' }),
    ],
    empty_addresses: [],
  })

  assert.match(rendered, /trusted = var\.trusted/)
  assert.match(rendered, /script = <<-EOT\nline one\nline two\nEOT/)
  assert.match(rendered, /__raw = true/)
  assert.match(rendered, /value = "var\.forged"/)
  assert.equal((rendered.match(/inbound_rule \{/g) || []).length, 2)
  assert.match(rendered, /port_range = "443"/)
  assert.match(rendered, /empty_addresses = \[\]/)
})

test('renders deterministic secure DigitalOcean service Terraform', () => {
  const first = renderTerraform({ manifest: manifest(), environment: 'production' })
  const second = renderTerraform({ manifest: manifest(), environment: 'production' })
  assert.deepEqual(second, first)

  assert.match(first['versions.tf'], /version = "2\.96\.0"/)

  const main = first['main.tf']
  assert.match(main, /resource "digitalocean_project" "vertile_services"/)
  assert.match(main, /purpose = "Web Application"/)
  assert.match(main, /environment = "Production"/)
  assert.match(main, /resource "digitalocean_droplet" "service_api_service"/)
  assert.match(main, /resource "digitalocean_reserved_ip" "service_api_service_reserved_ip"/)
  assert.match(main, /resource "digitalocean_reserved_ip_assignment" "service_api_service_reserved_ip"/)
  assert.match(main, /resource "digitalocean_firewall" "service_api_service"/)
  assert.match(main, /resource "digitalocean_project_resources" "vertile_services"/)
  assert.match(main, /region = "ams3"/)
  assert.match(main, /size = "s-1vcpu-2gb"/)
  assert.match(main, /image = "ubuntu-24-04-x64"/)
  assert.match(main, /backups = true/)
  assert.match(main, /monitoring = true/)
  assert.match(main, /graceful_shutdown = true/)
  assert.match(main, /ssh_keys = \[\n    "SHA256:abc123",\n  \]/)
  assert.match(main, /droplet_id = digitalocean_droplet\.service_api_service\.id/)
  assert.match(main, /resources = \[\n    digitalocean_droplet\.service_api_service\.urn,\n  \]/)
  assert.doesNotMatch(
    main.match(/resource "digitalocean_project_resources" "vertile_services" \{[\s\S]*?\n\}/)?.[0] || '',
    /digitalocean_reserved_ip/,
  )
  assert.match(main, /user_data = <<-CLOUD_INIT\n#cloud-config/)
  assert.match(main, /ssh_pwauth: false/)
  assert.match(main, /disable_root: true/)
  assert.match(main, /name: vertile/)
  assert.doesNotMatch(main, /groups: docker/)
  assert.doesNotMatch(main, /NOPASSWD/)
  assert.match(main, /\/srv\/vertile\/api_service/)
  assert.match(main, /\/var\/lib\/vertile-iac\/bootstrap-complete/)
  assert.doesNotMatch(main, /3000/)
  assert.doesNotMatch(main, /\$\{.*\}/)
  assert.equal((main.match(/inbound_rule \{/g) || []).length, 3)
  assert.match(main, /port_range = "80"/)
  assert.match(main, /port_range = "443"/)
  assert.match(main, /port_range = "22"/)
  assert.match(main, /source_addresses = \[\n      "203\.0\.113\.10\/32",\n      "2001:db8::\/48",\n    \]/)
  assert.doesNotMatch(main, /port_range = "3000"/)
  assert.match(main, /protocol = "tcp"\n    port_range = "1-65535"/)
  assert.match(main, /protocol = "udp"\n    port_range = "1-65535"/)
  assert.match(main, /outbound_rule \{\n    protocol = "icmp"\n    destination_addresses = \[[\s\S]*?\n  \}/)
  assert.doesNotMatch(
    main.match(/outbound_rule \{\n    protocol = "icmp"[\s\S]*?\n  \}/)?.[0] || '',
    /port_range/,
  )
  assert.doesNotMatch(main, /port_range = "all"/)

  const outputs = first['outputs.tf']
  assert.match(outputs, /output "digitalocean_service_api_service_droplet_id"/)
  assert.match(outputs, /value = digitalocean_droplet\.service_api_service\.id/)
  assert.match(outputs, /output "digitalocean_service_api_service_reserved_ip"/)
  assert.match(outputs, /value = digitalocean_reserved_ip\.service_api_service_reserved_ip\.ip_address/)
  assert.match(outputs, /output "digitalocean_service_api_service_public_host"/)
  assert.match(outputs, /value = digitalocean_reserved_ip\.service_api_service_reserved_ip\.ip_address/)
  assert.match(outputs, /output "digitalocean_service_api_service_ssh_user"/)
  assert.match(outputs, /value = "vertile"/)
  assert.match(outputs, /output "digitalocean_service_api_service_application_directory"/)
  assert.match(outputs, /value = "\/srv\/vertile\/api_service"/)
  assert.match(outputs, /output "digitalocean_service_api_service_application_port"/)
  assert.match(outputs, /value = 3000/)
  assert.match(outputs, /output "digitalocean_service_api_service_health_check_path"/)
})

test('DigitalOcean project maps non-production deployments to allowed provider environment values', () => {
  const rendered = renderTerraform({
    manifest: manifest(),
    environment: 'uat',
    deployment: { name: 'uat', environment: 'uat', values: { region: 'sfo3' } },
  })

  assert.match(rendered['main.tf'], /name = "svc_sample_uat_services"/)
  assert.match(rendered['main.tf'], /purpose = "Web Application"/)
  assert.match(rendered['main.tf'], /environment = "Staging"/)
})

test('DigitalOcean services without management CIDRs omit SSH ingress', () => {
  const noSshManifest = manifest({
    services: [
      {
        key: 'api-service',
        app: 'web',
        runtime: 'container',
        port: 3000,
        providers: {
          digitalocean: {
            region: 'ams3',
          },
        },
      },
    ],
  })
  const main = renderTerraform({ manifest: noSshManifest, environment: 'production' })['main.tf']

  assert.equal((main.match(/inbound_rule \{/g) || []).length, 2)
  assert.match(main, /port_range = "80"/)
  assert.match(main, /port_range = "443"/)
  assert.doesNotMatch(main, /port_range = "22"/)
})

test('DigitalOcean service region resolves deployment before provider config and fails clearly when absent', () => {
  const deploymentManifest = manifest({
    providers: {
      digitalocean: {
        deployments: { uat: { environment: 'uat', region: 'sfo3' } },
      },
    },
    services: [{
      key: 'api',
      app: 'web',
      runtime: 'container',
      port: 3000,
      providers: { digitalocean: {} },
    }],
  })

  assert.match(
    renderTerraform({
      manifest: deploymentManifest,
      environment: 'uat',
      deployment: { name: 'uat', environment: 'uat', values: { region: 'sfo3' } },
    })['main.tf'],
    /region = "sfo3"/,
  )

  assert.throws(
    () => renderTerraform({
      manifest: deploymentManifest,
      environment: 'production',
      deployment: { name: '', environment: 'production', values: {} },
    }),
    /DigitalOcean region is required for service "api"/,
  )
})

test('DigitalOcean provider version override and generic resources remain literal and conflict checked', () => {
  const rendered = renderTerraform({
    manifest: manifest({
      providers: {
        digitalocean: {
          version: '2.97.1',
          region: 'nyc3',
          resources: [
            {
              type: 'digitalocean_tag',
              name: 'literal',
              values: { name: { __raw: true, value: 'var.bad' } },
            },
          ],
        },
      },
    }),
    environment: 'production',
  })

  assert.match(rendered['versions.tf'], /version = "2\.97\.1"/)
  assert.match(rendered['main.tf'], /resource "digitalocean_tag" "literal"/)
  assert.match(rendered['main.tf'], /__raw = true/)
  assert.match(rendered['main.tf'], /value = "var\.bad"/)

  assert.throws(
    () => renderTerraform({
      manifest: manifest({
        providers: {
          digitalocean: {
            region: 'nyc3',
            resources: [{ type: 'digitalocean_droplet', name: 'service_api_service', values: {} }],
          },
        },
      }),
      environment: 'production',
    }),
    /conflicts with generated DigitalOcean service Terraform address/,
  )
})

test('DigitalOcean deployment provider version overrides provider default', () => {
  const rendered = renderTerraform({
    manifest: manifest({
      providers: {
        digitalocean: {
          version: '2.97.1',
          region: 'nyc3',
        },
      },
    }),
    environment: 'uat',
    deployment: {
      name: 'uat',
      environment: 'uat',
      values: {
        version: '2.98.0',
        region: 'sfo3',
      },
    },
  })

  assert.match(rendered['versions.tf'], /version = "2\.98\.0"/)
})

test('DigitalOcean Spaces backend renders deterministic S3-compatible backend without credentials', () => {
  const backendManifest = manifest({
    providers: {
      digitalocean: {
        region: 'nyc3',
        backend: {
          type: 'spaces',
          bucket: 'terraform-state',
          region: 'sfo3',
        },
        deployments: {
          beta: {
            environment: 'uat',
            region: 'sfo3',
            stateKey: 'sample/beta/terraform.tfstate',
          },
          prod: {
            environment: 'production',
            region: 'nyc3',
            stateKey: 'sample/prod/terraform.tfstate',
          },
        },
      },
    },
  })

  const beta = renderTerraform({
    manifest: backendManifest,
    environment: 'uat',
    deployment: {
      name: 'beta',
      environment: 'uat',
      values: backendManifest.providers.digitalocean.deployments.beta,
    },
  })
  const prod = renderTerraform({
    manifest: backendManifest,
    environment: 'production',
    deployment: {
      name: 'prod',
      environment: 'production',
      values: backendManifest.providers.digitalocean.deployments.prod,
    },
  })

  assert.deepEqual(
    renderTerraform({
      manifest: backendManifest,
      environment: 'uat',
      deployment: {
        name: 'beta',
        environment: 'uat',
        values: backendManifest.providers.digitalocean.deployments.beta,
      },
    }),
    beta,
  )

  assert.equal(backendManifest.providers.digitalocean.backend.useLockfile, true)
  assert.match(beta['backend.tf'], /required_version = "~> 1\.11"/)
  assert.match(beta['backend.tf'], /backend "s3" \{/)
  assert.match(beta['backend.tf'], /s3 = "https:\/\/sfo3\.digitaloceanspaces\.com"/)
  assert.match(beta['backend.tf'], /bucket = "terraform-state"/)
  assert.match(beta['backend.tf'], /key = "sample\/beta\/terraform\.tfstate"/)
  assert.match(prod['backend.tf'], /key = "sample\/prod\/terraform\.tfstate"/)
  assert.notEqual(beta['backend.tf'], prod['backend.tf'])
  assert.match(beta['backend.tf'], /region = "us-east-1"/)
  assert.match(beta['backend.tf'], /skip_credentials_validation = true/)
  assert.match(beta['backend.tf'], /skip_requesting_account_id = true/)
  assert.match(beta['backend.tf'], /skip_metadata_api_check = true/)
  assert.match(beta['backend.tf'], /skip_region_validation = true/)
  assert.match(beta['backend.tf'], /skip_s3_checksum = true/)
  assert.match(beta['backend.tf'], /use_lockfile = true/)
  assert.doesNotMatch(Object.values(beta).join('\n'), /token|access-key|secret-key|do-secret/i)
})

test('DigitalOcean Spaces object storage emits DNS-safe bucket names and rejects unsafe overrides', () => {
  const rendered = renderTerraform({
    manifest: manifest({
      project: { name: 'svc_sample' },
      objectStorage: [{ key: 'uploads' }],
    }),
    environment: 'production',
  })

  assert.match(rendered['main.tf'], /resource "digitalocean_spaces_bucket" "object_storage_uploads"/)
  assert.match(rendered['main.tf'], /name = "svc-sample-production-uploads"/)

  const publicStorage = renderTerraform({
    manifest: manifest({
      objectStorage: [{ key: 'public-assets', visibility: 'public' }],
    }),
    environment: 'production',
  })
  assert.match(publicStorage['main.tf'], /acl = "public-read"/)
  assert.match(rendered['outputs.tf'], /output "digitalocean_object_storage_uploads_bucket_name"/)
  assert.match(rendered['outputs.tf'], /output "digitalocean_object_storage_uploads_endpoint"/)
  assert.match(rendered['outputs.tf'], /output "digitalocean_object_storage_uploads_bucket_domain_name"/)
  assert.match(rendered['outputs.tf'], /output "digitalocean_object_storage_uploads_region"/)

  assert.throws(
    () => normalizeManifest({
      version: 1,
      project: { name: 'svc-sample' },
      environments: ['production'],
      providers: {
        digitalocean: {
          region: 'syd1',
          backend: {
            type: 'spaces',
            bucket: 'terraform_state',
            region: 'syd1',
          },
        },
      },
      apps: [],
      objectStorage: [{
        key: 'uploads',
        providers: { digitalocean: { name: 'unsafe_bucket_name' } },
      }],
    }),
    /valid DigitalOcean Spaces bucket name/,
  )

  assert.throws(
    () => normalizeManifest({
      version: 1,
      project: { name: 'svc-sample' },
      environments: ['production'],
      providers: {
        digitalocean: {
          region: 'syd1',
          backend: {
            type: 'spaces',
            bucket: 'unsafe_state_bucket',
            region: 'syd1',
          },
        },
      },
      apps: [],
    }),
    /valid DigitalOcean Spaces bucket name/,
  )

  assert.throws(
    () => normalizeManifest({
      version: 1,
      project: { name: 'svc-sample' },
      environments: ['production'],
      providers: { digitalocean: { region: 'syd1' } },
      apps: [],
      objectStorage: [{ key: 'uploads', visibility: 'world-readable' }],
    }),
    /objectStorage\.uploads\.visibility must be "private" or "public"/,
  )
})

test('DigitalOcean Spaces backend supports lockfile opt out for Terraform 1.6.3 compatibility', () => {
  const backendManifest = manifest({
    providers: {
      digitalocean: {
        region: 'nyc3',
        backend: {
          type: 'spaces',
          bucket: 'terraform-state',
          region: 'nyc3',
          useLockfile: false,
        },
        deployments: {
          prod: {
            environment: 'production',
            stateKey: 'sample/prod.tfstate',
          },
        },
      },
    },
  })

  const rendered = renderTerraform({
    manifest: backendManifest,
    environment: 'production',
    deployment: {
      name: 'prod',
      environment: 'production',
      values: backendManifest.providers.digitalocean.deployments.prod,
    },
  })

  assert.match(rendered['backend.tf'], /required_version = ">= 1\.6\.3"/)
  assert.doesNotMatch(rendered['backend.tf'], /use_lockfile/)
})

test('DigitalOcean backend validation rejects inline credentials, unsafe region slugs, and invalid state keys', () => {
  for (const field of ['credentials', 'accessKey', 'secretKey', 'token']) {
    assert.throws(
      () => manifest({
        providers: {
          digitalocean: {
            region: 'nyc3',
            backend: {
              type: 'spaces',
              bucket: 'terraform-state',
              region: 'nyc3',
              [field]: 'do-secret',
            },
          },
        },
      }),
      /must not be configured.*AWS_ACCESS_KEY_ID/,
    )
  }

  for (const region of ['https://sfo3.digitaloceanspaces.com', 'sfo3/path', 'SFO3', 'sfo3\n', 'nyc3.local']) {
    assert.throws(
      () => manifest({
        providers: {
          digitalocean: {
            region: 'nyc3',
            backend: {
              type: 'spaces',
              bucket: 'terraform-state',
              region,
            },
          },
        },
      }),
      /backend\.region must be a lowercase DigitalOcean region slug/,
    )
  }

  for (const stateKey of [
    '',
    ' sample/prod.tfstate',
    'sample/prod.tfstate ',
    './sample/prod.tfstate',
    'sample//prod.tfstate',
    'sample\\prod.tfstate',
    'sample/\nprod.tfstate',
    '/bad.tfstate',
    'env/../bad.tfstate',
    'env/',
  ]) {
    assert.throws(
      () => manifest({
        providers: {
          digitalocean: {
            region: 'nyc3',
            backend: {
              type: 'spaces',
              bucket: 'terraform-state',
              region: 'nyc3',
            },
            deployments: {
              prod: { environment: 'production', stateKey },
            },
          },
        },
      }),
      /stateKey must be a non-empty safe relative object key/,
    )
  }
})

test('DigitalOcean backend render keeps runtime guards for unsafe selected state and region values', () => {
  const backendManifest = manifest({
    providers: {
      digitalocean: {
        region: 'nyc3',
        backend: {
          type: 'spaces',
          bucket: 'terraform-state',
          region: 'nyc3',
        },
        deployments: {
          prod: { environment: 'production', stateKey: 'sample/prod.tfstate' },
        },
      },
    },
  })

  backendManifest.providers.digitalocean.deployments.prod.stateKey = 'sample//prod.tfstate'
  assert.throws(
    () => renderTerraform({
      manifest: backendManifest,
      environment: 'production',
      deployment: {
        name: 'prod',
        environment: 'production',
        values: backendManifest.providers.digitalocean.deployments.prod,
      },
    }),
    /stateKey must be a non-empty safe relative object key/,
  )

  backendManifest.providers.digitalocean.deployments.prod.stateKey = 'sample/prod.tfstate'
  backendManifest.providers.digitalocean.backend.region = 'https://nyc3.digitaloceanspaces.com'
  assert.throws(
    () => renderTerraform({
      manifest: backendManifest,
      environment: 'production',
      deployment: {
        name: 'prod',
        environment: 'production',
        values: backendManifest.providers.digitalocean.deployments.prod,
      },
    }),
    /backend\.region must be a lowercase DigitalOcean region slug/,
  )

  assert.throws(
    () => renderTerraform({
      manifest: backendManifest,
      environment: 'production',
      deployment: { name: '', environment: 'production', values: {} },
    }),
    /requires a selected deployment with stateKey/,
  )
})

test('writeTarget removes stale top-level Terraform files while preserving Terraform state and non-Terraform files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-render-'))
  try {
    const context = { generatedRoot: path.join(root, '.vertile', 'terraform') }
    const workspace = path.join(context.generatedRoot, 'digitalocean')
    await mkdir(path.join(workspace, '.terraform'), { recursive: true })
    await writeFile(path.join(workspace, 'backend.tf'), 'stale backend\n')
    await writeFile(path.join(workspace, 'outputs.tf'), 'stale outputs\n')
    await writeFile(path.join(workspace, 'main.tf'), 'stale main\n')
    await writeFile(path.join(workspace, 'terraform.tfstate'), 'state\n')
    await writeFile(path.join(workspace, 'terraform.tfstate.backup'), 'backup\n')
    await writeFile(path.join(workspace, '.terraform.lock.hcl'), 'lock\n')
    await writeFile(path.join(workspace, 'notes.txt'), 'keep\n')
    await writeFile(path.join(workspace, '.terraform', 'cached.tf'), 'cache\n')

    await writeTarget({
      context,
      manifest: manifest({ services: [] }),
      environment: 'production',
      target: 'digitalocean',
    })

    assert.equal(await readFile(path.join(workspace, 'main.tf'), 'utf8').then((value) => value.includes('provider "digitalocean"')), true)
    await assert.rejects(() => readFile(path.join(workspace, 'backend.tf'), 'utf8'), /ENOENT/)
    await assert.rejects(() => readFile(path.join(workspace, 'outputs.tf'), 'utf8'), /ENOENT/)
    assert.equal(await readFile(path.join(workspace, 'terraform.tfstate'), 'utf8'), 'state\n')
    assert.equal(await readFile(path.join(workspace, 'terraform.tfstate.backup'), 'utf8'), 'backup\n')
    assert.equal(await readFile(path.join(workspace, '.terraform.lock.hcl'), 'utf8'), 'lock\n')
    assert.equal(await readFile(path.join(workspace, 'notes.txt'), 'utf8'), 'keep\n')
    assert.equal(await readFile(path.join(workspace, '.terraform', 'cached.tf'), 'utf8'), 'cache\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
