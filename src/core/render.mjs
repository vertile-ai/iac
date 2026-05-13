import fs from 'node:fs/promises'
import path from 'node:path'
import { targetWorkspace } from './context.mjs'
import { renderTerraform as renderAws } from '../providers/aws/index.mjs'
import { renderTerraform as renderDigitalOcean } from '../providers/digitalocean/index.mjs'
import { renderTerraform as renderVercel } from '../providers/vercel/index.mjs'

const renderers = {
  aws: renderAws,
  digitalocean: renderDigitalOcean,
  vercel: renderVercel,
}

export function renderTarget({ manifest, environment, target }) {
  const render = renderers[target]
  if (!render) throw new Error(`No renderer registered for target "${target}".`)
  return render({ manifest, environment })
}

export async function writeTarget({ context, manifest, environment, target }) {
  const workspace = targetWorkspace(context, target)
  const files = renderTarget({ manifest, environment, target })
  await fs.mkdir(workspace, { recursive: true })

  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(workspace, name), contents)
  }

  return { workspace, files }
}

export async function writeTargets({ context, manifest, environment, targets }) {
  const rendered = []
  for (const target of targets) {
    rendered.push(await writeTarget({ context, manifest, environment, target }))
  }
  return rendered
}
