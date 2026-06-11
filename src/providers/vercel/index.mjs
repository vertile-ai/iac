import {
  block,
  raw,
  renderGenericResources,
  renderLocals,
  renderRequiredProvider,
  sanitizeName,
} from '../../core/hcl.mjs'

function providerBody(config) {
  return {
    team: config.team || config.teamId || config.teamSlug,
  }
}

function appProject(app) {
  return block('resource', ['vercel_project', sanitizeName(app.key)], {
    name: app.name,
    framework: app.framework,
    root_directory: app.rootDirectory,
  })
}

function appDomains(app) {
  const domains = Array.isArray(app.domains) ? app.domains : []
  return domains.map((domain) => domainResource(domain, app.key))
}

function deployableApps(manifest) {
  return manifest.apps.filter((app) => app.deploy !== false && app.providers?.vercel?.deploy !== false)
}

function domainResource(domain, appKey) {
  const name = typeof domain === 'string' ? domain : domain.name
  const targetApp = appKey || domain.app || domain.project
  if (!name || !targetApp) return ''

  const resourceName = sanitizeName(`${targetApp}_${name}`)
  return block('resource', ['vercel_project_domain', resourceName], {
    project_id: raw(`vercel_project.${sanitizeName(targetApp)}.id`),
    domain: name,
  })
}

export function renderTerraform({ manifest, environment }) {
  const config = manifest.providers.vercel || {}
  const apps = deployableApps(manifest)
  const appBlocks = apps.map(appProject)
  const appDomainBlocks = apps.flatMap(appDomains)
  const topLevelDomainBlocks = manifest.domains.map((domain) => domainResource(domain))
  const genericResources = renderGenericResources(config.resources)
  const mainBlocks = [
    renderLocals(manifest, environment),
    block('provider', ['vercel'], providerBody(config)),
    ...appBlocks,
    ...appDomainBlocks,
    ...topLevelDomainBlocks,
    genericResources,
  ].filter(Boolean)

  return {
    'versions.tf': `${renderRequiredProvider('vercel', 'vercel/vercel', '>= 1.0.0')}\n`,
    'main.tf': `${mainBlocks.join('\n\n')}\n`,
  }
}
