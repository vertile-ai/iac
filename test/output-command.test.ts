// @ts-nocheck
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseSingleTargetOption, parseTerraformInitOptions } from '../src/core/args.js'
import { terraformInitArgs } from '../src/core/terraform.js'
import { testing as outputTesting } from '../src/output.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vertile-iac-output-'))
  await writeFile(path.join(root, 'package.json'), '{}\n')
  await mkdir(path.join(root, 'infrastructure', 'iac'), { recursive: true })
  await writeFile(
    path.join(root, 'infrastructure', 'iac', 'iac.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'sample' },
      environments: ['staging', 'production'],
      providers: {
        digitalocean: {
          region: 'nyc3',
          deployments: {
            beta: {
              environment: 'staging',
              region: 'sfo3',
            },
          },
        },
      },
      apps: [{ key: 'web' }],
      objectStorage: [{ key: 'uploads' }],
    }) + '\n',
  )
  return root
}

function execNode(args, cwd, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd, env: options.env }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout,
        stderr,
      })
    })
  })
}

async function terraformMock(root, script) {
  const terraformBin = path.join(root, 'terraform-mock')
  await writeFile(terraformBin, script)
  await chmod(terraformBin, 0o755)
  return terraformBin
}

test('output command renders one target, initializes explicitly, and flattens Terraform JSON only', async () => {
  const root = await fixture()
  const logPath = path.join(root, 'terraform-output.log')
  const terraformBin = await terraformMock(
    root,
    `#!/bin/sh
printf "%s|%s\\n" "$PWD" "$*" >> "$TERRAFORM_LOG"
if [ "$*" = "output -json" ]; then
  printf '{"z_name":{"sensitive":false,"type":"string","value":"last"},"a_name":{"sensitive":false,"type":["list","string"],"value":["first"]}}'
fi
`,
  )

  try {
    const result = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'output',
      '--repo-root',
      root,
      '--target=digitalocean',
      '--deployment=beta',
      '--env=staging',
      '--terraform-bin',
      terraformBin,
      '--migrate-state',
      '--json',
    ], packageRoot, {
      env: { ...process.env, TERRAFORM_LOG: logPath },
    })

    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), {
      target: 'digitalocean',
      deployment: 'beta',
      environment: 'staging',
      outputs: {
        a_name: ['first'],
        z_name: 'last',
      },
    })
    assert.equal(result.stdout.trim().startsWith('{'), true)

    const log = await readFile(logPath, 'utf8')
    assert.match(log, /\.vertile\/terraform\/digitalocean\/beta\|init -input=false -migrate-state -force-copy/)
    assert.match(log, /\.vertile\/terraform\/digitalocean\/beta\|output -json/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('output command rejects all or multiple targets before running Terraform', async () => {
  assert.throws(() => parseSingleTargetOption(['--target=all']), /exactly one target/)
  assert.throws(() => parseSingleTargetOption(['--target=aws,digitalocean']), /exactly one target/)
  assert.equal(parseSingleTargetOption(['--target=digitalocean']), 'digitalocean')
})

test('Terraform init lifecycle flags are explicit and mutually exclusive', () => {
  assert.deepEqual(terraformInitArgs(), ['init', '-input=false'])
  assert.deepEqual(terraformInitArgs({ migrateState: true }), ['init', '-input=false', '-migrate-state', '-force-copy'])
  assert.deepEqual(terraformInitArgs({ reconfigure: true }), ['init', '-input=false', '-reconfigure'])
  assert.throws(() => terraformInitArgs({ migrateState: true, reconfigure: true }), /mutually exclusive/)
  assert.throws(() => parseTerraformInitOptions(['--migrate-state', '--reconfigure']), /mutually exclusive/)
})

test('output command rejects malformed, failed, and sensitive Terraform output', async () => {
  assert.deepEqual(outputTesting.parseTerraformOutput('{"name":{"sensitive":false,"value":"value"}}'), { name: 'value' })
  assert.deepEqual(
    Object.keys(outputTesting.parseTerraformOutput(
      '{"a":{"sensitive":false,"value":1},"Z":{"sensitive":false,"value":2},"_":{"sensitive":false,"value":3}}',
    )),
    ['Z', '_', 'a'],
  )
  assert.throws(() => outputTesting.parseTerraformOutput('not json'), /malformed JSON/)
  assert.throws(() => outputTesting.parseTerraformOutput('[]'), /must return a JSON object/)
  assert.throws(
    () => outputTesting.parseTerraformOutput('{"secret":{"sensitive":true,"value":"do-not-print"}}'),
    /Refusing to print outputs without sensitive=false: secret/,
  )
  assert.throws(
    () => outputTesting.parseTerraformOutput('{"secret":{"value":"do-not-print"}}'),
    (error: any) => {
      assert.match(error.message, /Refusing to print outputs without sensitive=false: secret/)
      assert.doesNotMatch(error.message, /do-not-print/)
      return true
    },
  )
  assert.throws(
    () => outputTesting.parseTerraformOutput('{"secret":{"sensitive":"false","value":"do-not-print"}}'),
    (error: any) => {
      assert.match(error.message, /Refusing to print outputs without sensitive=false: secret/)
      assert.doesNotMatch(error.message, /do-not-print/)
      return true
    },
  )

  const root = await fixture()
  const terraformBin = await terraformMock(
    root,
    `#!/bin/sh
if [ "$*" = "output -json" ]; then
  printf 'bad json'
fi
`,
  )
  try {
    const malformed = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'output',
      '--repo-root',
      root,
      '--target=digitalocean',
      '--terraform-bin',
      terraformBin,
    ], packageRoot)
    assert.equal(malformed.code, 1)
    assert.match(malformed.stderr, /malformed JSON/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const failedRoot = await fixture()
  const failingTerraform = await terraformMock(
    failedRoot,
    `#!/bin/sh
echo "provider failed" >&2
exit 7
`,
  )
  try {
    const failed = await execNode([
      path.join(packageRoot, 'dist', 'src', 'cli.js'),
      'output',
      '--repo-root',
      failedRoot,
      '--target=digitalocean',
      '--terraform-bin',
      failingTerraform,
    ], packageRoot)
    assert.equal(failed.code, 1)
    assert.match(failed.stderr, /failed with exit code 7: provider failed/)
  } finally {
    await rm(failedRoot, { recursive: true, force: true })
  }
})
