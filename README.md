# @jazelly/iac

Opinionated infrastructure-as-code tooling.

Install once, define infrastructure once, then run `jazelly-iac plan` or
guarded `jazelly-iac apply` to manage Vercel, AWS, and DigitalOcean changes
from the same IaC source of truth.

Product repos keep their own manifests and env source files, while this package
renders provider-specific Terraform workspaces and keeps the existing
Vercel reconciliation flow available as compatibility commands.

## Install

```bash
pnpm add -D @jazelly/iac
```

Terraform is required for `jazelly-iac plan`. The `render` command does not call
Terraform and can be used offline.

## Commands

```bash
jazelly-iac render --target=all --env=production
jazelly-iac plan --target=vercel --env=preview
jazelly-iac apply --target=aws --env=production --yes

jazelly-iac env --repo-root ../noop --scope=all --targets=preview,production
jazelly-iac projects --repo-root ../noop
jazelly-iac domains --repo-root ../noop
```

The `render`, `plan`, and `apply` commands read `infrastructure/iac/iac.json`
and write generated Terraform workspaces to `.jazelly/terraform/<target>/`.

Apply is guarded. Non-interactive apply requires `--yes`, which passes
Terraform `-auto-approve`.

The `env`, `projects`, and `domains` commands are compatibility commands for
the existing Vercel API reconciliation flow.

Apply mode requires `VERCEL_TOKEN`, `VERCEL_API_KEY`, or a token file:

```bash
VERCEL_TOKEN=... jazelly-iac env --repo-root ../noop --apply
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
infrastructure/iac/env-manifest.json
infrastructure/iac/project-settings.json
infrastructure/iac/project-domains.json
infrastructure/shared/.env.development
infrastructure/shared/.env.staging
infrastructure/shared/.env.production
infrastructure/<project-key>/.env.development
infrastructure/<project-key>/.env.staging
infrastructure/<project-key>/.env.production
```

Vercel targets map to env files as follows:

- `development` -> `.env.development`
- `preview` -> `.env.staging`
- `production` -> `.env.production`

Pure local env files such as `.env.local` are intentionally not synced to
Vercel. The default manifest location can be overridden:

```bash
jazelly-iac env \
  --repo-root ../some-project \
  --manifest ./deploy/env-manifest.json \
  --infra-dir infrastructure
```

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
- `--out <path>`: generated Terraform root, default `.jazelly/terraform`.
- `--target <name|all>`: `vercel`, `aws`, `digitalocean`, or `all`.
- `--env <name>`: environment to render, plan, or apply, default `production`.
- `--terraform-bin <path>`: Terraform executable for `plan`, default `terraform`.
- `--yes`: allow non-interactive `apply` with Terraform auto-approve.

## Docs

Public-facing docs live in `docs/`. The static docs website entrypoint is:

```text
docs/index.html
```

## Publishing

Publish with restricted access:

```bash
pnpm publish --access restricted
```
