import {
  block,
  hclBlock,
  heredoc,
  raw,
  renderGenericResources,
  renderLocals,
  renderOutput,
  renderRequiredProvider,
  sanitizeName,
} from '../../core/hcl.js'
import {
  compactBody,
  providerObjectStorageName,
  providerResourceName,
  providerValues,
  resourceName,
} from '../../core/concepts.js'

function deploymentLabel(environment, deployment: any = {}) {
  return deployment.name || environment
}

function projectEnvironment(environment) {
  if (environment === 'production') return 'Production'
  if (['development', 'local', 'test'].includes(environment)) return 'Development'
  return 'Staging'
}

function region(config: any, values: any) {
  return values.region || config.region || 'nyc3'
}

function serviceRegion(providerConfig: any, deploymentValues: any, serviceValues: any, serviceKey) {
  const resolved = serviceValues.region || deploymentValues.region || providerConfig.region
  if (!resolved) {
    throw new Error(
      `DigitalOcean region is required for service "${serviceKey}". Configure services.${serviceKey}.providers.digitalocean.region, the selected digitalocean deployment region, or providers.digitalocean.region.`,
    )
  }
  return resolved
}

function serviceAddress(service, suffix = '') {
  return resourceName('service', service.key, suffix)
}

function isDigitalOceanRegionSlug(value) {
  return typeof value === 'string' && /^[a-z0-9]+$/.test(value)
}

function serviceOutputName(service, suffix) {
  return resourceName('digitalocean_service', service.key, suffix)
}

function serviceApplicationDirectory(service) {
  return `/srv/vertile/${sanitizeName(service.key)}`
}

function serviceCloudInit(service) {
  return [
    '#cloud-config',
    'ssh_pwauth: false',
    'disable_root: true',
    'users:',
    '  - name: vertile',
    '    shell: /bin/bash',
    '    lock_passwd: true',
    'package_update: true',
    'packages:',
    '  - docker.io',
    'write_files:',
    '  - path: /etc/ssh/sshd_config.d/99-vertile-iac.conf',
    "    permissions: '0644'",
    '    content: |',
    '      PasswordAuthentication no',
    '      PermitRootLogin no',
    'runcmd:',
    '  - [ systemctl, enable, --now, docker ]',
    '  - [ usermod, -aG, docker, vertile ]',
    `  - [ install, -d, -o, vertile, -g, vertile, -m, "0750", ${serviceApplicationDirectory(service)} ]`,
    '  - [ install, -d, -o, vertile, -g, vertile, -m, "0700", /home/vertile/.ssh ]',
    "  - [ bash, -lc, 'if [ -f /root/.ssh/authorized_keys ]; then cp /root/.ssh/authorized_keys /home/vertile/.ssh/authorized_keys && chown vertile:vertile /home/vertile/.ssh/authorized_keys && chmod 0600 /home/vertile/.ssh/authorized_keys; fi' ]",
    '  - [ systemctl, reload, ssh ]',
    '  - [ install, -d, -m, "0755", /var/lib/vertile-iac ]',
    '  - [ touch, /var/lib/vertile-iac/bootstrap-complete ]',
  ].join('\n')
}

function globalCidrBlocks() {
  return ['0.0.0.0/0', '::/0']
}

function firewallBlocks(service, dropletAddress, cidrs) {
  const inboundRules = [
    hclBlock('inbound_rule', {
      protocol: 'tcp',
      port_range: '80',
      source_addresses: globalCidrBlocks(),
    }),
    hclBlock('inbound_rule', {
      protocol: 'tcp',
      port_range: '443',
      source_addresses: globalCidrBlocks(),
    }),
    ...(cidrs.length > 0 ? [
      hclBlock('inbound_rule', {
        protocol: 'tcp',
        port_range: '22',
        source_addresses: cidrs,
      }),
    ] : []),
  ]

  return block('resource', ['digitalocean_firewall', serviceAddress(service)], {
    name: resourceName(service.key, 'firewall'),
    droplet_ids: [raw(`digitalocean_droplet.${dropletAddress}.id`)],
    inbound_rule: inboundRules,
    outbound_rule: [
      hclBlock('outbound_rule', {
        protocol: 'tcp',
        port_range: '1-65535',
        destination_addresses: globalCidrBlocks(),
      }),
      hclBlock('outbound_rule', {
        protocol: 'udp',
        port_range: '1-65535',
        destination_addresses: globalCidrBlocks(),
      }),
      hclBlock('outbound_rule', {
        protocol: 'icmp',
        destination_addresses: globalCidrBlocks(),
      }),
    ],
  })
}

function serviceBlocks(manifest, environment, providerConfig, deployment: any = {}) {
  const deploymentValues = deployment.values || {}
  const nameEnvironment = deploymentLabel(environment, deployment)
  const services = manifest.services || []
  if (services.length === 0) return []

  const blocks = [
    block('resource', ['digitalocean_project', 'vertile_services'], {
      name: resourceName(manifest.project.name, nameEnvironment, 'services'),
      description: `Services for ${manifest.project.name} ${nameEnvironment}.`,
      purpose: 'Web Application',
      environment: projectEnvironment(environment),
    }),
  ]
  const projectResources: any[] = []

  for (const service of services) {
    const values = providerValues(service, 'digitalocean')
    const dropletAddress = serviceAddress(service)
    const reservedIpAddress = serviceAddress(service, 'reserved_ip')
    const resolvedRegion = serviceRegion(providerConfig, deploymentValues, values, service.key)
    const tags = [
      sanitizeName(manifest.project.name),
      sanitizeName(environment),
      'service',
      sanitizeName(service.key),
    ]

    blocks.push(block('resource', ['digitalocean_droplet', dropletAddress], compactBody({
      name: values.name || providerResourceName(manifest, nameEnvironment, service),
      image: values.image || 'ubuntu-24-04-x64',
      region: resolvedRegion,
      size: values.sizeSlug || values.size || 's-1vcpu-2gb',
      backups: values.backups ?? true,
      monitoring: values.monitoring ?? true,
      graceful_shutdown: true,
      ssh_keys: values.sshKeyFingerprints,
      tags,
      user_data: heredoc(serviceCloudInit(service), 'CLOUD_INIT'),
    })))
    blocks.push(block('resource', ['digitalocean_reserved_ip', reservedIpAddress], {
      region: resolvedRegion,
    }))
    blocks.push(block('resource', ['digitalocean_reserved_ip_assignment', reservedIpAddress], {
      ip_address: raw(`digitalocean_reserved_ip.${reservedIpAddress}.ip_address`),
      droplet_id: raw(`digitalocean_droplet.${dropletAddress}.id`),
    }))
    blocks.push(firewallBlocks(service, dropletAddress, values.managementCidrs || []))

    projectResources.push(raw(`digitalocean_droplet.${dropletAddress}.urn`))
  }

  blocks.push(block('resource', ['digitalocean_project_resources', 'vertile_services'], {
    project: raw('digitalocean_project.vertile_services.id'),
    resources: projectResources,
  }))

  return blocks
}

function generatedServiceAddresses(manifest) {
  const addresses = new Set()
  const services = manifest.services || []
  if (services.length === 0) return addresses

  addresses.add('digitalocean_project.vertile_services')
  addresses.add('digitalocean_project_resources.vertile_services')

  for (const service of services) {
    addresses.add(`digitalocean_droplet.${serviceAddress(service)}`)
    addresses.add(`digitalocean_reserved_ip.${serviceAddress(service, 'reserved_ip')}`)
    addresses.add(`digitalocean_reserved_ip_assignment.${serviceAddress(service, 'reserved_ip')}`)
    addresses.add(`digitalocean_firewall.${serviceAddress(service)}`)
  }

  return addresses
}

function assertNoGeneratedAddressConflicts(providerConfig, manifest) {
  const generated = generatedServiceAddresses(manifest)
  const resources = Array.isArray(providerConfig.resources) ? providerConfig.resources : []
  for (const resource of resources) {
    const address = `${resource.type}.${resource.name}`
    if (generated.has(address)) {
      throw new Error(
        `providers.digitalocean.resources entry "${address}" conflicts with generated DigitalOcean service Terraform address "${address}".`,
      )
    }
  }
}

function isSafeStateKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (value !== value.trim()) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false
  if (value.startsWith('/') || value.endsWith('/')) return false

  const segments = value.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function backendBlock(providerConfig, deployment) {
  const backend = providerConfig.backend
  if (!backend) return ''
  if (!deployment.name) {
    throw new Error(
      'DigitalOcean Spaces backend requires a selected deployment with stateKey. Pass --deployment or use an environment name that resolves to a digitalocean deployment.',
    )
  }
  if (!isSafeStateKey(deployment.values?.stateKey)) {
    throw new Error(
      `iac.json providers.digitalocean.deployments.${deployment.name}.stateKey must be a non-empty safe relative object key using only ASCII letters, digits, ".", "_", "-", and "/", without leading "/", trailing "/", empty segments, ".", or ".." path segments.`,
    )
  }
  if (!isDigitalOceanRegionSlug(backend.region)) {
    throw new Error('iac.json providers.digitalocean.backend.region must be a lowercase DigitalOcean region slug using only ASCII letters and digits.')
  }

  return `${block('terraform', [], {
    required_version: backend.useLockfile ? '~> 1.11' : '>= 1.6.3',
    backend: hclBlock('backend', {
      endpoints: {
        s3: `https://${backend.region}.digitaloceanspaces.com`,
      },
      bucket: backend.bucket,
      key: deployment.values.stateKey,
      region: 'us-east-1',
      skip_credentials_validation: true,
      skip_requesting_account_id: true,
      skip_metadata_api_check: true,
      skip_region_validation: true,
      skip_s3_checksum: true,
      ...(backend.useLockfile ? { use_lockfile: true } : {}),
    }, ['s3']),
  })}\n`
}

function objectStorageBlocks(manifest, environment, config, deployment = {}) {
  const nameEnvironment = deploymentLabel(environment, deployment)
  return manifest.objectStorage.map((item) => {
    const values = providerValues(item, 'digitalocean')
    const acl = values.acl || (item.visibility === 'public' ? 'public-read' : 'private')
    return block('resource', ['digitalocean_spaces_bucket', resourceName('object_storage', item.key)], compactBody({
      name: providerObjectStorageName(manifest, nameEnvironment, item, 'digitalocean'),
      region: region(config, values),
      acl,
    }))
  })
}

function databaseBlocks(manifest, environment, config, deployment = {}) {
  const nameEnvironment = deploymentLabel(environment, deployment)
  return manifest.databases.map((item) => {
    const values = providerValues(item, 'digitalocean')
    return block('resource', ['digitalocean_database_cluster', resourceName('database', item.key)], compactBody({
      name: values.name || providerResourceName(manifest, nameEnvironment, item),
      engine: values.engine || item.engine || 'pg',
      version: values.version || '15',
      size: values.size || 'db-s-1vcpu-1gb',
      region: region(config, values),
      node_count: values.nodeCount || 1,
    }))
  })
}

function dropletBlocks(manifest, environment, config, deployment = {}, field, prefix) {
  const nameEnvironment = deploymentLabel(environment, deployment)
  return manifest[field].map((item) => {
    const values = providerValues(item, 'digitalocean')
    return block('resource', ['digitalocean_droplet', resourceName(prefix, item.key)], compactBody({
      name: values.name || providerResourceName(manifest, nameEnvironment, item),
      image: values.image || 'ubuntu-24-04-x64',
      region: region(config, values),
      size: values.sizeSlug || values.size || 's-1vcpu-1gb',
      count: field === 'clusters' ? values.nodes || item.nodes || item.size || 1 : undefined,
      tags: [manifest.project.name, environment, prefix],
    }))
  })
}

function outputBlocks(manifest) {
  const objectStorageOutputs = manifest.objectStorage.flatMap((item) => {
    const address = `digitalocean_spaces_bucket.${resourceName('object_storage', item.key)}`
    return [
      renderOutput(resourceName('digitalocean_object_storage', item.key, 'bucket_name'), {
        value: raw(`${address}.name`),
      }),
      renderOutput(resourceName('digitalocean_object_storage', item.key, 'endpoint'), {
        value: raw(`${address}.endpoint`),
      }),
      renderOutput(resourceName('digitalocean_object_storage', item.key, 'bucket_domain_name'), {
        value: raw(`${address}.bucket_domain_name`),
      }),
      renderOutput(resourceName('digitalocean_object_storage', item.key, 'region'), {
        value: raw(`${address}.region`),
      }),
    ]
  })

  return objectStorageOutputs.concat((manifest.services || []).flatMap((service) => {
    const dropletAddress = serviceAddress(service)
    const reservedIpAddress = serviceAddress(service, 'reserved_ip')
    const serviceOutputs = [
      renderOutput(serviceOutputName(service, 'droplet_id'), {
        value: raw(`digitalocean_droplet.${dropletAddress}.id`),
      }),
      renderOutput(serviceOutputName(service, 'reserved_ip'), {
        value: raw(`digitalocean_reserved_ip.${reservedIpAddress}.ip_address`),
      }),
      renderOutput(serviceOutputName(service, 'public_host'), {
        value: raw(`digitalocean_reserved_ip.${reservedIpAddress}.ip_address`),
      }),
      renderOutput(serviceOutputName(service, 'ssh_user'), {
        value: 'vertile',
      }),
      renderOutput(serviceOutputName(service, 'application_directory'), {
        value: serviceApplicationDirectory(service),
      }),
      renderOutput(serviceOutputName(service, 'application_port'), {
        value: service.port,
      }),
    ]

    if (service.healthCheck?.path) {
      serviceOutputs.push(renderOutput(serviceOutputName(service, 'health_check_path'), {
        value: service.healthCheck.path,
      }))
    }

    return serviceOutputs
  }))
}

export function renderTerraform({ manifest, environment, deployment = {} }: any) {
  const providerConfig = manifest.providers.digitalocean || {}
  assertNoGeneratedAddressConflicts(providerConfig, manifest)
  const config = {
    ...providerConfig,
    ...(deployment.values || {}),
  }
  const resources = renderGenericResources(providerConfig.resources)
  const mainBlocks = [
    renderLocals(manifest, environment, deployment),
    block('provider', ['digitalocean'], {}),
    ...objectStorageBlocks(manifest, environment, config, deployment),
    ...databaseBlocks(manifest, environment, config, deployment),
    ...dropletBlocks(manifest, environment, config, deployment, 'sandboxes', 'sandbox'),
    ...dropletBlocks(manifest, environment, config, deployment, 'clusters', 'cluster'),
    ...serviceBlocks(manifest, environment, providerConfig, deployment),
    resources,
  ].filter(Boolean)

  return {
    'versions.tf': `${renderRequiredProvider('digitalocean', 'digitalocean/digitalocean', config.version || '2.96.0')}\n`,
    ...(providerConfig.backend ? { 'backend.tf': backendBlock(providerConfig, deployment) } : {}),
    'main.tf': `${mainBlocks.join('\n\n')}\n`,
    ...(outputBlocks(manifest).length > 0 ? { 'outputs.tf': `${outputBlocks(manifest).join('\n\n')}\n` } : {}),
  }
}
