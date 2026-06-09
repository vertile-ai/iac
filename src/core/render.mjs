import fs from 'node:fs/promises'
import path from 'node:path'
import { targetWorkspace } from './context.mjs'
import { resolveDeployment } from './deployments.mjs'
import { assertEnvironment } from './manifest.mjs'
import { renderTerraform as renderAws } from '../providers/aws/index.mjs'
import { renderTerraform as renderDigitalOcean } from '../providers/digitalocean/index.mjs'
import { renderTerraform as renderVercel } from '../providers/vercel/index.mjs'

const renderers = {
  aws: renderAws,
  digitalocean: renderDigitalOcean,
  vercel: renderVercel,
}

export function renderTarget({ manifest, environment, target, deploymentName = '' }) {
  const render = renderers[target]
  if (!render) throw new Error(`No renderer registered for target "${target}".`)
  const deployment = resolveDeployment({ manifest, target, environment, deploymentName })
  assertEnvironment(manifest, deployment.environment)
  return render({ manifest, environment: deployment.environment, deployment })
}

export async function writeTarget({ context, manifest, environment, target, deploymentName = '' }) {
  const deployment = resolveDeployment({ manifest, target, environment, deploymentName })
  assertEnvironment(manifest, deployment.environment)
  const workspace = targetWorkspace(context, target, deployment.name)
  const files = renderTarget({
    manifest,
    environment: deployment.environment,
    target,
    deploymentName: deployment.name,
  })
  await fs.mkdir(workspace, { recursive: true })

  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(workspace, name), contents)
  }

  return { workspace, files, deployment }
}

export async function writeTargets({ context, manifest, environment, targets, deploymentName = '' }) {
  const rendered = []
  for (const target of targets) {
    rendered.push(await writeTarget({ context, manifest, environment, target, deploymentName }))
  }
  return rendered
}
