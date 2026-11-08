import { spawnSync } from 'node:child_process'

function failureMessage(terraformBin, args, result) {
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const detail = stderr ? `: ${stderr}` : ''
  return `${terraformBin} ${args.join(' ')} failed with exit code ${result.status}${detail}`
}

function runTerraform({ terraformBin, workspace, args, stdio = 'inherit' }: any) {
  const result = spawnSync(terraformBin, args, {
    cwd: workspace,
    stdio,
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
  })

  if (result.error) {
    throw new Error(`Failed to run ${terraformBin}: ${result.error.message}`)
  }

  if (result.status !== 0) {
    throw new Error(failureMessage(terraformBin, args, result))
  }

  return result
}

export function terraformInitArgs({ migrateState = false, reconfigure = false }: any = {}) {
  if (migrateState && reconfigure) {
    throw new Error('--migrate-state and --reconfigure are mutually exclusive.')
  }
  return [
    'init',
    '-input=false',
    ...(migrateState ? ['-migrate-state', '-force-copy'] : []),
    ...(reconfigure ? ['-reconfigure'] : []),
  ]
}

export function terraformPlan({ terraformBin, workspace, init = {} }: any) {
  runTerraform({
    terraformBin,
    workspace,
    args: terraformInitArgs(init),
  })
  runTerraform({
    terraformBin,
    workspace,
    args: ['plan', '-input=false'],
  })
}

export function terraformApply({ terraformBin, workspace, autoApprove = false, init = {} }: any) {
  runTerraform({
    terraformBin,
    workspace,
    args: terraformInitArgs(init),
  })
  runTerraform({
    terraformBin,
    workspace,
    args: ['apply', '-input=false', ...(autoApprove ? ['-auto-approve'] : [])],
  })
}

export function terraformOutputJson({ terraformBin, workspace, init = {} }: any) {
  runTerraform({
    terraformBin,
    workspace,
    args: terraformInitArgs(init),
    stdio: 'pipe',
  })
  const result = runTerraform({
    terraformBin,
    workspace,
    args: ['output', '-json'],
    stdio: 'pipe',
  })
  return result.stdout || ''
}
