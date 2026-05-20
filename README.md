# @vertile-ai/iac

Opinionated infrastructure-as-code tooling.

Install once, define infrastructure once, then run `vertile-iac plan` or
guarded `vertile-iac apply` to manage Vercel, AWS, and DigitalOcean changes
from the same IaC source of truth.

Product repos keep their own manifests and env source files, while this package
renders provider-specific Terraform workspaces and keeps the existing
Vercel reconciliation flow available as compatibility commands.

## Install

```bash
pnpm add -D @vertile-ai/iac
```

Terraform is required for `vertile-iac plan`. The `render` command does not call
Terraform and can be used offline.

## Commands

```bash
vertile-iac render --target=all --env=production
vertile-iac plan --target=vercel --env=preview
vertile-iac apply --target=aws --env=production --yes

vertile-iac sync-env --repo-root ../noop --variants=local,staging,test
vertile-iac env --repo-root ../noop --scope=all --targets=preview,production
vertile-iac projects --repo-root ../noop
vertile-iac domains --repo-root ../noop
```

The `render`, `plan`, and `apply` commands read `infrastructure/iac/iac.json`
and write generated Terraform workspaces to `.vertile/terraform/<target>/`.

Apply is guarded. Non-interactive apply requires `--yes`, which passes
Terraform `-auto-approve`.

The `env`, `projects`, and `domains` commands reconcile Vercel through the
Vercel API. They still read the older compatibility manifest files when those
files exist, and otherwise derive the same desired state from
`infrastructure/iac/iac.json`.

Apply mode requires `VERCEL_TOKEN`, `VERCEL_API_KEY`, or a token file:

```bash
VERCEL_TOKEN=... vertile-iac env --repo-root ../noop --apply
```

## Manifest Layout

The new Terraform flow expects the target project to have:

```text
infrastructure/iac/iac.json
infrastructure/shared/.env.development
infrastructure/shared/.env.staging
infrastructure/shared/.env.production
infrastructure/<app-key>/.env.development
infrastructure/<app-key>/.env.staging
infrastructure/<app-key>/.env.production
```

Minimal `iac.json` example:

```json
{
  "$schema": "./node_modules/@vertile-ai/iac/schema/iac.schema.json",
  "version": 1,
  "project": { "name": "example" },
  "environments": ["development", "preview", "production"],
  "providers": {
    "vercel": { "team": "example-team" },
    "aws": { "region": "us-east-1" },
    "digitalocean": {}
  },
  "apps": [
    {
      "key": "web",
      "name": "example-web",
      "framework": "nextjs",
      "rootDirectory": "apps/web",
      "domains": ["web.example.com"]
    }
  ],
  "env": {
    "sourceDir": "infrastructure",
    "sync": {
      "apps": ["web"]
    }
  },
  "domains": []
}
```

Portable concepts currently include:

- `apps`
- `domains`
- `objectStorage`
- `databases`
- `queues`
- `sandboxes`
- `clusters`

Provider-specific Terraform resources can be added under
`providers.<target>.resources` as `{ "type", "name", "values" }` objects while
the manifest schema stays narrow.

The compatibility Vercel commands expect the target project to have:

```text
infrastructure/shared/.env.development
infrastructure/shared/.env.staging
infrastructure/shared/.env.production
infrastructure/<project-key>/.env.development
infrastructure/<project-key>/.env.staging
infrastructure/<project-key>/.env.production
```

When the old compatibility files exist, they are used directly:

```text
infrastructure/iac/env-manifest.json
infrastructure/iac/project-settings.json
infrastructure/iac/project-domains.json
```

When they do not exist, the Vercel commands derive equivalent manifests from
`iac.json`:

- `providers.vercel.teamSlug` or `providers.vercel.team` becomes the Vercel team.
- `env.sourceDir` selects the env source folder and defaults to `infrastructure`.
- `apps[].key`, `apps[].id` or `apps[].projectId`, and `apps[].name` become managed Vercel projects.
- `apps[].rootDirectory`, `apps[].nodeVersion`, and
  `apps[].enableAffectedProjectsDeployments` become project settings.
- `apps[].domains` and top-level `domains[]` become project domains.

Vercel targets map to env files as follows:

- `development` -> `.env.development`
- `preview` -> `.env.staging`
- `production` -> `.env.production`

Pure local env files such as `.env.local` are intentionally not synced to
Vercel. The default manifest location can be overridden:

```bash
vertile-iac env \
  --repo-root ../some-project \
  --manifest ./deploy/env-manifest.json \
  --infra-dir infrastructure
```

## Env File Sync

`vertile-iac sync-env` generates package-local `.env.*` files from the env
source tree declared by `iac.json`. This is separate from `vertile-iac env`,
which reconciles Vercel remote environment variables.

The boundary is:

- `env.sourceDir` is the source tree, defaulting to `infrastructure`.
- `env.sync.sharedKey` is the shared source folder, defaulting to `shared`.
- `env.sync.apps` limits which `apps[]` are materialized locally. Without it,
  all apps are synced.
- Each app reads from `<env.sourceDir>/<app.key>` by default.
- Each app writes into `apps[].rootDirectory` by default.
- `apps[].env.sourceKey` and `apps[].env.outputDir` override those defaults.
- `apps[].env.sharedPrefix` projects prefixed shared keys into one app, strips
  the prefix in that app's generated file, and keeps those prefixed keys out of
  other generated app env files.

Examples:

```json
{
  "env": {
    "sourceDir": "infrastructure",
    "sync": {
      "apps": ["landing", "web-client", "web-server"],
      "sharedKey": "shared"
    }
  },
  "apps": [
    {
      "key": "web-client",
      "rootDirectory": "packages/web-client",
      "env": { "sharedPrefix": "WEB_CLIENT_" }
    }
  ]
}
```

Supported local sync variants are `local`, `staging`, `preview`, `production`,
and `test`. `preview` is an alias for `.env.staging`.

## Shared Options

- `--repo-root <path>`: product repo root containing `infrastructure/`.
- `--iac-dir <path>`: manifest directory, default `infrastructure/iac`.
- `--manifest <path>`: env manifest path.
- `--project-settings <path>`: project settings manifest path.
- `--project-domains <path>`: project domains manifest path.
- `--infra-dir <path>`: override `env-manifest.json` `infraDir`.
- `--token-file <path>`: token file, default `<repo-root>/.vercel.token`.
- `--auto-create-keys <a,b>`: project keys allowed for Vercel auto-create.
- `--auto-create-prefixes <a,b>`: project key prefixes allowed for Vercel auto-create.
- `--iac-manifest <path>`: source-of-truth IaC manifest, default `<iac-dir>/iac.json`.
- `--out <path>`: generated Terraform root, default `.vertile/terraform`.
- `--target <name|all>`: `vercel`, `aws`, `digitalocean`, or `all`.
- `--env <name>`: environment to render, plan, or apply, default `production`.
- `--terraform-bin <path>`: Terraform executable for `plan`, default `terraform`.
- `--yes`: allow non-interactive `apply` with Terraform auto-approve.

## Docs

Public-facing docs live in `docs/`. The static docs website entrypoint is:

```text
docs/index.html
```

## Examples

The `examples/` directory uses runtime-oriented fixture names so each project
shape is clear at a glance:

- `examples/node-api`
- `examples/bun-hono-api`
- `examples/react-spa`
- `examples/next-monorepo`
- `examples/sveltekit-web`
- `examples/python-fastapi-api`
- `examples/go-api`

Every example keeps a portable `infrastructure/iac/iac.json`. Examples with
provider-specific fields also include standalone provider variants such as
`iac.aws.json`, `iac.vercel.json`, or `iac.do.json` that can be passed with
`--iac-manifest`.

## Schema

The manifest schema is published as JSON Schema Draft 2020-12:

```text
schema/iac.schema.json
```

Product manifests can reference the package copy:

```json
{
  "$schema": "./node_modules/@vertile-ai/iac/schema/iac.schema.json"
}
```

## Publishing

Publish with public access:

```bash
pnpm publish --access public
```
