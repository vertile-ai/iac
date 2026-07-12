# @vertile-ai/iac

[简体中文](README.zh-CN.md)

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
```

`render` is offline and writes Terraform to `.vertile/terraform/<provider>/`.
`plan` and `apply` require Terraform. Apply is intentionally guarded:
non-interactive runs require `--yes`, which passes Terraform’s
`-auto-approve` flag. Before `plan` or `apply`, configure the selected cloud
provider’s credentials as you normally would for Terraform. A successful first
render creates files such as `.vertile/terraform/aws/main.tf`; inspect them
before running a plan.

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
vertile-iac env --scope=all --targets=preview,production
vertile-iac github-actions --env=staging
```

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

## What belongs in the manifest

`apps`, `domains`, `objectStorage`, `databases`, `queues`, `sandboxes`, and
`clusters` describe product needs. Use `providers.<target>.resources` for a
provider-specific escape hatch when the portable model does not yet cover a
resource. Provider deployments add stage-specific values without forking the
whole manifest.

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
