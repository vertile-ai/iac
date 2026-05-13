import {
  block,
  renderGenericResources,
  renderLocals,
  renderOutput,
  renderRequiredProvider,
} from '../../core/hcl.mjs'
import {
  compactBody,
  providerResourceName,
  providerValues,
  resourceName,
} from '../../core/concepts.mjs'

function region(config, values) {
  return values.region || config.region || 'nyc3'
}

function objectStorageBlocks(manifest, environment, config) {
  return manifest.objectStorage.map((item) => {
    const values = providerValues(item, 'digitalocean')
    return block('resource', ['digitalocean_spaces_bucket', resourceName('object_storage', item.key)], compactBody({
      name: values.name || providerResourceName(manifest, environment, item),
      region: region(config, values),
      acl: values.acl || 'private',
    }))
  })
}

function databaseBlocks(manifest, environment, config) {
  return manifest.databases.map((item) => {
    const values = providerValues(item, 'digitalocean')
    return block('resource', ['digitalocean_database_cluster', resourceName('database', item.key)], compactBody({
      name: values.name || providerResourceName(manifest, environment, item),
      engine: values.engine || item.engine || 'pg',
      version: values.version || '15',
      size: values.size || 'db-s-1vcpu-1gb',
      region: region(config, values),
      node_count: values.nodeCount || 1,
    }))
  })
}

function dropletBlocks(manifest, environment, config, field, prefix) {
  return manifest[field].map((item) => {
    const values = providerValues(item, 'digitalocean')
    return block('resource', ['digitalocean_droplet', resourceName(prefix, item.key)], compactBody({
      name: values.name || providerResourceName(manifest, environment, item),
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

export function renderTerraform({ manifest, environment }) {
  const config = manifest.providers.digitalocean || {}
  const resources = renderGenericResources(config.resources)
  const mainBlocks = [
    renderLocals(manifest, environment),
    block('provider', ['digitalocean'], {}),
    ...objectStorageBlocks(manifest, environment, config),
    ...databaseBlocks(manifest, environment, config),
    ...dropletBlocks(manifest, environment, config, 'sandboxes', 'sandbox'),
    ...dropletBlocks(manifest, environment, config, 'clusters', 'cluster'),
    resources,
  ].filter(Boolean)

  return {
    'versions.tf': `${renderRequiredProvider('digitalocean', 'digitalocean/digitalocean', config.version || '>= 2.0.0')}\n`,
    'main.tf': `${mainBlocks.join('\n\n')}\n`,
    ...(outputBlocks(manifest).length > 0 ? { 'outputs.tf': `${outputBlocks(manifest).join('\n\n')}\n` } : {}),
  }
}
