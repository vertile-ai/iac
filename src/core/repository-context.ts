import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { readManifest } from './manifest.js'
import { defaultPrivateValuesPath } from './private-values.js'

function commandOutput(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function githubRepositoryFromRemote(remote) {
  const match = remote.match(/(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (!match) return undefined

  return { kind: 'github', owner: match[1], repo: match[2] }
}

function authenticatedGithubUser(repoRoot) {
  const user = commandOutput('gh', ['api', 'user', '--jq', '.login'], repoRoot)
  if (!user) {
    throw new Error('Could not resolve local repository identity. Authenticate GitHub CLI with gh auth login.')
  }
  return user
}

export function inferRepositoryIdentity(repoRoot) {
  const remote = commandOutput('git', ['config', '--get', 'remote.origin.url'], repoRoot)
  return githubRepositoryFromRemote(remote) || {
    kind: 'local',
    user: authenticatedGithubUser(repoRoot),
    repo: path.basename(repoRoot),
  }
}

export function resolveRepositoryContext({ repoRoot, manifestPath, stack, environment }) {
  const manifestRef = path.resolve(manifestPath || path.join(repoRoot, 'iac.json'))
  const manifest = readManifest(manifestRef)
  const [owner, repo] = manifest.repository.split('/')
  const repository = { kind: 'github', owner, repo }
  const projectRoot = path.dirname(manifestRef)

  return {
    repository,
    manifestRef,
    privateValuesRef: defaultPrivateValuesPath(projectRoot),
    terraformStateDirectory: path.join(
      os.homedir(),
      '.iac',
      'repositories',
      'github',
      owner,
      repo,
      'terraform',
      stack,
      environment,
    ),
  }
}
