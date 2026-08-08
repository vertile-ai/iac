# @vertile-ai/iac

[简体中文](README.zh-CN.md)

[![Release workflow](https://github.com/vertile-ai/iac/actions/workflows/release.yml/badge.svg)](https://github.com/vertile-ai/iac/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/vertile-ai/iac?display_name=tag&sort=semver)](https://github.com/vertile-ai/iac/releases)
[![npm version](https://img.shields.io/npm/v/%40vertile-ai%2Fiac)](https://www.npmjs.com/package/@vertile-ai/iac)
[![npm downloads/month](https://img.shields.io/npm/dm/%40vertile-ai%2Fiac?label=npm%20downloads%2Fmonth)](https://www.npmjs.com/package/@vertile-ai/iac)

Keep infrastructure intent, environment values, and deployment stages in one
reviewable file — then let the same command render the Vercel, AWS, or
DigitalOcean Terraform workspace you need. `@vertile-ai/iac` is for product
teams that want portable infrastructure without duplicating a project’s names,
domains, environments, and provider settings across scripts and dashboards.

It creates a dependable hand-off between application code and infrastructure:

- Developers describe *what the product needs* in `iac.json` beside the code.
- Reviewers see application and infrastructure changes together in one PR.
- CI gets deterministic Terraform output for each provider and deployment
  stage, rather than relying on manually configured state.
- Existing Vercel environment, project-setting, domain, and GitHub Actions
  environment configuration remain available while a repository moves to the
  unified manifest.

In practical terms: changing a domain, environment, or deployment stage means
changing one reviewed file instead of copying settings through cloud consoles.

## Releases

Changesets drives releases from GitHub Actions. Each push to `main` runs the
tests and checks; pending changesets create or update a release pull request,
and merging that pull request publishes the package to npm and creates the
corresponding GitHub release.

## Start here

Install the CLI in the product repository:

```bash
pnpm add -D @vertile-ai/iac
```

Create `iac.json` in the repository root (the CLI also accepts the legacy
`infrastructure/iac/iac.json` location), then render before you plan or apply:

```bash
pnpm exec vertile-iac render --target=all --env=production
pnpm exec vertile-iac plan --target=aws --env=production
pnpm exec vertile-iac apply --target=aws --deployment=prod --yes
pnpm exec vertile-iac output --target=digitalocean --deployment=prod --json
```

`render` is offline and writes Terraform to `.vertile/terraform/<provider>/` or
`.vertile/terraform/<provider>/<deployment>/`. `plan`, `apply`, and `output`
require Terraform. Apply is intentionally guarded: non-interactive runs require
`--yes`, which passes Terraform’s `-auto-approve` flag. Before `plan`, `apply`,
or `output`, configure the selected cloud provider’s credentials as you normally
would for Terraform. A successful first render creates files such as
`.vertile/terraform/aws/main.tf`; inspect them before running a plan.

## A useful first manifest

This is enough to give one web application a Vercel project and an AWS S3
bucket, while keeping the logical environments portable:

```json
{
  "$schema": "./node_modules/@vertile-ai/iac/schema/iac.schema.json",
  "version": 1,
  "project": { "name": "acme" },
  "environments": {
    "development": { "files": [".env.development"] },
    "staging": { "files": [".env.staging"] },
    "production": { "files": [".env.production"] }
  },
  "providers": {
    "vercel": { "teamSlug": "acme" },
    "aws": { "region": "ap-southeast-2" }
  },
  "apps": [
    {
      "key": "web",
      "name": "acme-web",
      "framework": "nextjs",
      "rootDirectory": "apps/web",
      "domains": ["app.example.com"]
    }
  ],
  "objectStorage": [{ "key": "uploads", "visibility": "private" }]
}
```

The schema is published with the package at
`schema/iac.schema.json`; point your editor at it for manifest completion and
validation.

## Choose the provider at execution time

The manifest holds portable product concepts. A target selects the provider
implementation without changing the app’s intent:

| Need | Command |
| --- | --- |
| Review generated configuration | `vertile-iac render --target=all --env=staging` |
| Plan one provider | `vertile-iac plan --target=vercel --env=production` |
| Apply an explicitly named stage | `vertile-iac apply --target=aws --deployment=prod --yes` |

Supported targets are `vercel`, `aws`, `digitalocean`, and `all`. Generated
workspaces are deterministic, so a plan can be reproduced locally and in CI.

Deployments let a team keep familiar names such as `uat`, `nightly`, or `prod`
while mapping them to logical environments and provider inputs:

```json
{
  "providers": {
    "aws": {
      "region": "ap-southeast-2",
      "deployments": {
        "prod": {
          "environment": "production",
          "profile": "acme-production",
          "tags": { "Stage": "production" }
        }
      }
    }
  }
}
```

That command writes to `.vertile/terraform/aws/prod/`; the mapped logical
environment still determines which env files are selected.

## Manage environment values without spreading secrets around

Put env source files under `.vertile-iac/env` by default:

```text
.vertile-iac/env/shared/.env.production
.vertile-iac/env/web/.env.production
```

The names in `environments.<name>.files` (for example
`.env.production`) are selected relative to each source folder above; they are
not an alternative root-level convention. You can add env files when you start
using `sync-env` or a reconciliation command — rendering Terraform from the
minimal manifest does not require them.

Declare metadata in `iac.json` under `env.metadata`. The CLI uses it to produce
package `.env` files, Vercel environment variables, and GitHub Actions
environment variables or secrets from the same source. This keeps the rule for
where a value may go next to the value’s owner, instead of re-creating it in
three systems.

```bash
vertile-iac sync-env --variants=local,staging,production
vertile-iac validate
vertile-iac env --scope=all --targets=preview,production
vertile-iac github-actions --env=staging
```

`test` is a test-runner mode, not a default infrastructure environment.
`sync-env` does not require or generate `.env.test`; tests should select an
environment explicitly declared by the manifest.

Without `--variants`, `sync-env` uses the manifest environments in declared
order. `validate` is an offline, read-only check for manifest-driven env routes.

The latter two commands are dry-runs unless `--apply` is supplied. Vercel apply
mode accepts `VERCEL_TOKEN`, `VERCEL_API_KEY`, `providers.vercel.token`, or
`providers.vercel.apiKey`; process environment values take precedence.

## Vercel compatibility commands

Teams already using Vercel can adopt the unified manifest without a flag day:

```bash
vertile-iac env --repo-root .
vertile-iac projects --repo-root .
vertile-iac domains --repo-root .
```

These derive Vercel desired state from `iac.json`. Explicit legacy
`project-settings.json` and `project-domains.json` inputs remain supported only
for compatibility. New projects should use the unified manifest.

## DigitalOcean Services, State, And Outputs

DigitalOcean `services` currently render one public container service to one
Droplet. `render`, `plan`, and `apply` create a secure empty host: a
DigitalOcean project, Droplet, Reserved IP, firewall, Docker bootstrap, non-root
`vertile` user, application directory, and readiness marker. They do not build
or deploy an image, write runtime secrets, configure DNS/TLS, start the app, or
prove health/WSS. The consumer release pipeline owns image publishing, secrets,
localhost app binding, reverse proxy/TLS, health checks, rollout, and rollback.

Generated firewalls open `80` and `443` publicly. The application port remains a
private upstream port for the release pipeline and reverse proxy. SSH ingress is
rendered only when `managementCidrs` is explicitly set and global CIDRs are
rejected; GitHub-hosted runner egress is not a stable firewall allowlist, so use
fixed egress, self-hosted runners, private networking, or pull-based deployment
instead of repeatedly changing Terraform firewall rules.

DigitalOcean remote state is optional. Local state remains the default. A Spaces
backend requires a pre-created bucket, env-only `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`, and a selected deployment with `stateKey`.
`--migrate-state` and `--reconfigure` are explicit Terraform init lifecycle
flags; migration uses Terraform `-force-copy` and is never automatic.

The DigitalOcean provider is pinned to `digitalocean/digitalocean` `2.96.0` by
default. Override it with `providers.digitalocean.version` or a deployment-level
`version`. See the manifest guide for field details and stable output names.

## What belongs in the manifest

`apps`, `services`, `domains`, `objectStorage`, `databases`, `queues`,
`sandboxes`, and `clusters` describe product needs. Use
`providers.<target>.resources` for a provider-specific escape hatch when the
portable model does not yet cover a resource. Provider deployments add
stage-specific values without forking the whole manifest.

For the complete field reference and examples, see:

- [Manifest guide](docs/manifest.md)
- [Schema documentation](docs/schema/iac-manifest.schema-doc.json)
- [Runnable examples](examples/)
- [Product direction and current scope](docs/roadmap.md)

## Development

The package is authored in TypeScript and ships compiled ESM in `dist/`.

```bash
pnpm install
pnpm run check
pnpm test
```

`pnpm test` builds first and enforces the repository’s coverage threshold.
