import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
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

export function resolveRepositoryContext({ repoRoot, stack, environment }) {
  const remote = commandOutput('git', ['config', '--get', 'remote.origin.url'], repoRoot)
  const repository: any = githubRepositoryFromRemote(remote) || {
    kind: 'local',
    user: authenticatedGithubUser(repoRoot),
    repo: path.basename(repoRoot),
  }
  const identityPath = repository.kind === 'github'
    ? ['github', repository.owner, repository.repo]
    : ['local', repository.user, repository.repo]

  return {
    repository,
    privateValuesRef: defaultPrivateValuesPath(repoRoot),
    terraformStateDirectory: path.join(
      os.homedir(),
      '.iac',
      'repositories',
      ...identityPath,
      'terraform',
      stack,
      environment,
    ),
  }
}
