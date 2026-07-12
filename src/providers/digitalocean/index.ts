import {
  block,
  renderGenericResources,
  renderLocals,
  renderOutput,
  renderRequiredProvider,
} from '../../core/hcl.js'
import {
  compactBody,
  providerResourceName,
  providerValues,
  resourceName,
} from '../../core/concepts.js'

function deploymentLabel(environment, deployment: any = {}) {
  return deployment.name || environment
}

function region(config: any, values: any) {
  return values.region || config.region || 'nyc3'
}

function objectStorageBlocks(manifest, environment, config, deployment = {}) {
  const nameEnvironment = deploymentLabel(environment, deployment)
  return manifest.objectStorage.map((item) => {
    const values = providerValues(item, 'digitalocean')
    return block('resource', ['digitalocean_spaces_bucket', resourceName('object_storage', item.key)], compactBody({
      name: values.name || providerResourceName(manifest, nameEnvironment, item),
      region: region(config, values),
      acl: values.acl || 'private',
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
  return manifest.objectStorage.map((item) => renderOutput(
    resourceName('digitalocean_object_storage', item.key, 'bucket_name'),
    {
      value: `\${digitalocean_spaces_bucket.${resourceName('object_storage', item.key)}.name}`,
    },
  ))
}

export function renderTerraform({ manifest, environment, deployment = {} }: any) {
  const providerConfig = manifest.providers.digitalocean || {}
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
    resources,
  ].filter(Boolean)

  return {
    'versions.tf': `${renderRequiredProvider('digitalocean', 'digitalocean/digitalocean', config.version || '>= 2.0.0')}\n`,
    'main.tf': `${mainBlocks.join('\n\n')}\n`,
    ...(outputBlocks(manifest).length > 0 ? { 'outputs.tf': `${outputBlocks(manifest).join('\n\n')}\n` } : {}),
  }
}
