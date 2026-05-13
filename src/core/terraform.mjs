import { spawnSync } from 'node:child_process'

function runTerraform({ terraformBin, workspace, args }) {
  const result = spawnSync(terraformBin, args, {
    cwd: workspace,
    stdio: 'inherit',
  })

  if (result.error) {
    throw new Error(`Failed to run ${terraformBin}: ${result.error.message}`)
  }

  if (result.status !== 0) {
    throw new Error(`${terraformBin} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

export function terraformPlan({ terraformBin, workspace }) {
  runTerraform({
    terraformBin,
    workspace,
    args: ['init', '-input=false'],
  })
  runTerraform({
    terraformBin,
    workspace,
    args: ['plan', '-input=false'],
  })
}

export function terraformApply({ terraformBin, workspace, autoApprove = false }) {
  runTerraform({
    terraformBin,
    workspace,
    args: ['init', '-input=false'],
  })
  runTerraform({
    terraformBin,
    workspace,
    args: ['apply', '-input=false', ...(autoApprove ? ['-auto-approve'] : [])],
  })
}
