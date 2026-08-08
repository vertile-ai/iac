import fs from 'node:fs/promises'
import path from 'node:path'
import { targetWorkspace } from './context.js'
import { resolveDeployment } from './deployments.js'
import { assertEnvironment } from './manifest.js'
import { renderTerraform as renderAws } from '../providers/aws/index.js'
import { renderTerraform as renderDigitalOcean } from '../providers/digitalocean/index.js'
import { renderTerraform as renderVercel } from '../providers/vercel/index.js'

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
  await removeStaleTerraformFiles(workspace, new Set(Object.keys(files as Record<string, string>)))

  for (const [name, contents] of Object.entries(files as Record<string, string>)) {
    await fs.writeFile(path.join(workspace, name), contents)
  }

  return { workspace, files, deployment }
}

async function removeStaleTerraformFiles(workspace, currentFiles: Set<string>) {
  const entries = await fs.readdir(workspace, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return
    if (!entry.name.endsWith('.tf')) return
    if (entry.name === '.terraform.lock.hcl') return
    if (entry.name.startsWith('terraform.tfstate')) return
    if (currentFiles.has(entry.name)) return
    await fs.rm(path.join(workspace, entry.name))
  }))
}

export async function writeTargets({ context, manifest, environment, targets, deploymentName = '' }) {
  const rendered = []
  for (const target of targets) {
    rendered.push(await writeTarget({ context, manifest, environment, target, deploymentName }))
  }
  return rendered
}
