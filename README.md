# @jazelly/iac

Private infrastructure-as-code tooling for Jazelly projects.

This package owns the Jazelly-standard Vercel reconciliation flow. Product repos
keep their own project manifests and env source files, while this package
provides the shared scripts that reconcile those files.

## Commands

```bash
jazelly-iac env --repo-root ../noop --scope=all --targets=preview,production
jazelly-iac projects --repo-root ../noop
jazelly-iac domains --repo-root ../noop
```

Apply mode requires `VERCEL_TOKEN`, `VERCEL_API_KEY`, or a token file:

```bash
VERCEL_TOKEN=... jazelly-iac env --repo-root ../noop --apply
```

## Manifest Layout

By default, commands expect the target project to have:

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

## Publishing

Publish with restricted access:

```bash
pnpm publish --access restricted
```

## Project Manifest Ownership

Project-specific manifests stay in the project repository. This package should
not contain Noop-specific, app-specific, or customer-specific manifests.
