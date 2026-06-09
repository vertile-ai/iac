function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function providerDeployments(manifest, target) {
  return asObject(asObject(manifest.providers[target]).deployments)
}

export function resolveDeployment({ manifest, target, environment, deploymentName = '' }) {
  const deployments = providerDeployments(manifest, target)
  const name = deploymentName || (deployments[environment] ? environment : '')

  if (!name) {
    return {
      name: '',
      environment,
      values: {},
    }
  }

  if (!deployments[name] && Object.keys(deployments).length === 0) {
    return {
      name: '',
      environment,
      values: {},
    }
  }

  if (!deployments[name]) {
    throw new Error(`Unknown ${target} deployment "${name}". Use one of: ${Object.keys(deployments).join(', ')}`)
  }

  const values = asObject(deployments[name])
  return {
    name,
    environment: values.environment || environment,
    values,
  }
}
