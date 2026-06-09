import {
  block,
  nestedBlock,
  raw,
  renderGenericResources,
  renderLocals,
  renderOutput,
  renderRequiredProvider,
  renderVariable,
} from '../../core/hcl.mjs'
import {
  compactBody,
  providerResourceName,
  providerValues,
  resourceName,
  terraformVariableName,
} from '../../core/concepts.mjs'

function deploymentLabel(environment, deployment = {}) {
  return deployment.name || environment
}

function providerBlock(manifest, environment, deployment = {}) {
  const config = manifest.providers.aws || {}
  const deploymentValues = deployment.values || {}
  const body = {
    region: deploymentValues.region || config.region,
    profile: deploymentValues.profile || config.profile,
  }
  const tags = compactBody({
    Project: manifest.project.name,
    Environment: environment,
    Deployment: deployment.name || undefined,
    ...(config.defaultTags || {}),
    ...(deploymentValues.tags || {}),
  })

  const provider = block('provider', ['aws'], body)
  const assumeRole = deploymentValues.assumeRole || deploymentValues.assume_role || config.assumeRole || config.assume_role
  const assumeRoleBlock = assumeRole
    ? `\n  ${nestedBlock('assume_role', assumeRole).replace(/\n/g, '\n  ')}`
    : ''
  const defaultTagsBlock = Object.keys(tags).length > 0
    ? `\n  ${nestedBlock('default_tags', { tags }).replace(/\n/g, '\n  ')}`
    : ''

  return `${provider.slice(0, -1)}${assumeRoleBlock}${defaultTagsBlock}\n}`
}

function objectStorageBlocks(manifest, environment, deployment = {}) {
  const nameEnvironment = deploymentLabel(environment, deployment)
  return manifest.objectStorage.map((item) => {
    const values = providerValues(item, 'aws')
    return block('resource', ['aws_s3_bucket', resourceName('object_storage', item.key)], compactBody({
      bucket: values.bucket || providerResourceName(manifest, nameEnvironment, item),
      force_destroy: values.forceDestroy,
    }))
  })
}

function queueBlocks(manifest, environment, deployment = {}) {
  const nameEnvironment = deploymentLabel(environment, deployment)
  return manifest.queues.map((item) => {
    const values = providerValues(item, 'aws')
    const fifo = values.fifo || item.kind === 'fifo'
    const baseName = values.name || providerResourceName(manifest, nameEnvironment, item)
    return block('resource', ['aws_sqs_queue', resourceName('queue', item.key)], compactBody({
      name: fifo && !baseName.endsWith('.fifo') ? `${baseName}.fifo` : baseName,
      fifo_queue: fifo || undefined,
      visibility_timeout_seconds: values.visibilityTimeoutSeconds,
      message_retention_seconds: values.messageRetentionSeconds,
    }))
  })
}

function databaseBlocks(manifest, environment, deployment = {}) {
  const nameEnvironment = deploymentLabel(environment, deployment)
  return manifest.databases.map((item) => {
    const values = providerValues(item, 'aws')
    const variable = terraformVariableName('database', item.key, 'password')
    return block('resource', ['aws_db_instance', resourceName('database', item.key)], compactBody({
      identifier: values.identifier || providerResourceName(manifest, nameEnvironment, item),
      engine: values.engine || item.engine || 'postgres',
      engine_version: values.engineVersion,
      instance_class: values.instanceClass || 'db.t4g.micro',
      allocated_storage: values.allocatedStorage || 20,
      db_name: values.databaseName || resourceName(item.key),
      username: values.username || 'app',
      password: raw(`var.${variable}`),
      publicly_accessible: values.publiclyAccessible || false,
      skip_final_snapshot: values.skipFinalSnapshot ?? true,
    }))
  })
}

function databaseVariables(manifest) {
  return manifest.databases.map((item) => renderVariable(
    terraformVariableName('database', item.key, 'password'),
    {
      type: raw('string'),
      sensitive: true,
      description: `Password for the ${item.key} database.`,
    },
  ))
}

function amazonLinuxDataSource() {
  return [
    'data "aws_ami" "amazon_linux" {',
    '  most_recent = true',
    '  owners      = ["amazon"]',
    '',
    '  filter {',
    '    name   = "name"',
    '    values = ["al2023-ami-*-x86_64"]',
    '  }',
    '}',
  ].join('\n')
}

function computeBlocks(manifest, environment, deployment, field, prefix) {
  const nameEnvironment = deploymentLabel(environment, deployment)
  return manifest[field].map((item) => {
    const values = providerValues(item, 'aws')
    return block('resource', ['aws_instance', resourceName(prefix, item.key)], compactBody({
      ami: values.ami ? values.ami : raw('data.aws_ami.amazon_linux.id'),
      instance_type: values.instanceType || 't3.micro',
      count: field === 'clusters' ? values.size || item.size || 1 : undefined,
      tags: compactBody({
        Name: values.name || providerResourceName(manifest, nameEnvironment, item),
        Project: manifest.project.name,
        Environment: environment,
        Deployment: deployment.name || undefined,
        Kind: prefix,
      }),
    }))
  })
}

function outputBlocks(manifest) {
  return manifest.objectStorage.map((item) => renderOutput(
    resourceName('aws_object_storage', item.key, 'bucket_name'),
    {
      value: raw(`aws_s3_bucket.${resourceName('object_storage', item.key)}.bucket`),
    },
  ))
}

export function renderTerraform({ manifest, environment, deployment = {} }) {
  const config = manifest.providers.aws || {}
  const resources = renderGenericResources(config.resources)
  const needsAmazonLinux = manifest.sandboxes.length > 0 || manifest.clusters.length > 0
  const mainBlocks = [
    renderLocals(manifest, environment, deployment),
    providerBlock(manifest, environment, deployment),
    needsAmazonLinux ? amazonLinuxDataSource() : '',
    ...objectStorageBlocks(manifest, environment, deployment),
    ...queueBlocks(manifest, environment, deployment),
    ...databaseBlocks(manifest, environment, deployment),
    ...computeBlocks(manifest, environment, deployment, 'sandboxes', 'sandbox'),
    ...computeBlocks(manifest, environment, deployment, 'clusters', 'cluster'),
    resources,
  ].filter(Boolean)
  const variableBlocks = databaseVariables(manifest)

  return {
    'versions.tf': `${renderRequiredProvider('aws', 'hashicorp/aws', '>= 5.0.0')}\n`,
    'main.tf': `${mainBlocks.join('\n\n')}\n`,
    ...(variableBlocks.length > 0 ? { 'variables.tf': `${variableBlocks.join('\n\n')}\n` } : {}),
    ...(outputBlocks(manifest).length > 0 ? { 'outputs.tf': `${outputBlocks(manifest).join('\n\n')}\n` } : {}),
  }
}
