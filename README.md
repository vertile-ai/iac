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
vertile-iac apply --target=aws --deployment=prod --yes

vertile-iac sync-env --repo-root ../noop --variants=local,staging,test
vertile-iac sync-env --repo-root ../noop --write-examples
vertile-iac env --repo-root ../noop --scope=all --targets=preview,production
vertile-iac projects --repo-root ../noop
vertile-iac domains --repo-root ../noop
```

The `render`, `plan`, and `apply` commands read `infrastructure/iac/iac.json`
and write generated Terraform workspaces to `.vertile/terraform/<target>/`.
When `--deployment=<name>` maps to a provider deployment, the workspace is
`.vertile/terraform/<target>/<deployment>/`.

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
.vertile-iac/env/shared/.env.development
.vertile-iac/env/shared/.env.staging
.vertile-iac/env/shared/.env.production
.vertile-iac/env/<app-key>/.env.development
.vertile-iac/env/<app-key>/.env.staging
.vertile-iac/env/<app-key>/.env.production
```

Minimal `iac.json` example:

```json
{
  "$schema": "./node_modules/@vertile-ai/iac/schema/iac.schema.json",
  "version": 1,
  "project": { "name": "example" },
  "environments": {
    "development": { "files": [".env.development"] },
    "uat": { "files": [".env.uat"] },
    "production": { "files": [".env.production"] }
  },
  "providers": {
    "vercel": { "team": "example-team" },
    "aws": {
      "region": "us-east-1",
      "deployments": {
        "uat": {
          "environment": "uat",
          "region": "us-east-1",
          "profile": "example-uat",
          "tags": { "Stage": "uat" }
        },
        "prod": {
          "environment": "production",
          "region": "us-east-1",
          "profile": "example-prod",
          "tags": { "Stage": "prod" }
        }
      }
    },
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

Provider deployments map user-defined stage names such as `uat`, `nightly`, or
`prod` to logical environments and provider-specific inputs. AWS uses deployment
values for provider region/profile, generated workspace path, resource names,
and default tags. The logical environment still controls env file selection.

By default, Vercel env reconciliation reads `.env.*` files from
`.vertile-iac/env/shared` and `.vertile-iac/env/<project-key>`.

The source of truth for Vercel env reconciliation is
`infrastructure/iac/iac.json`. Project settings and domain compatibility files
can still be read explicitly or as fallbacks for those commands:

```text
infrastructure/iac/project-settings.json
infrastructure/iac/project-domains.json
```

When `iac.json` is used, the Vercel commands derive equivalent manifests from
the unified manifest:

- `providers.vercel.teamSlug` or `providers.vercel.team` becomes the Vercel team.
- `env.sourceDir` selects the env source folder and defaults to `.vertile-iac/env`.
- Top-level `environments.<name>.files` maps logical environments to ordered env files.
- `apps[].key`, `apps[].id` or `apps[].projectId`, and `apps[].name` become managed Vercel projects.
- `apps[].rootDirectory`, `apps[].nodeVersion`, and
  `apps[].enableAffectedProjectsDeployments` become project settings.
- `apps[].domains` and top-level `domains[]` become project domains.

Vercel targets map to logical environments as follows by default:

- `development` -> `development`
- `preview` -> `staging`
- `production` -> `production`

Those logical environments then resolve through top-level `environments`. For example,
`staging` defaults to `.env.staging`, but can be configured as
`"staging": { "files": [".env.preview", ".env.staging"] }`.
Legacy Vercel env fallback manifests are no longer supported.

## Env File Sync

`vertile-iac sync-env` generates package-local `.env.*` files from the env
source tree declared by `iac.json`. This is separate from `vertile-iac env`,
which reconciles Vercel remote environment variables.

The boundary is:

- `env.sourceDir` is the source tree, defaulting to `.vertile-iac/env`.
- Top-level `environments.<name>.files` declares ordered source files for any logical
  environment, including custom names such as `uat`, `nightly`, or `qa`.
- `env.sync.directOutputs: true` writes package `.env.*` files directly from
  manifest metadata values instead of materializing intermediate source env
  files.
- `env.sync.sharedKey` is the compatibility shared source folder, defaulting to `shared`.
- `env.sync.apps` limits which `apps[]` are materialized locally. Without it,
  all apps are synced.
- `env.sync.patchVariantsFromExample: true` creates missing selected variant
  files from `.env.example` and appends missing example keys before package env
  files are generated. The CLI also accepts `--patch-variants-from-example`.
- Env metadata should be declared in `iac.json` under
  `env.metadata.<source-key>`, where source keys are `shared` and app source
  keys such as `web`, `admin`, or `api` in compatibility mode. In direct-output
  mode, source keys are metadata groups and package ownership is controlled by
  variable `targets`.
- File-based `<env.sourceDir>/<source-key>/.env.json` metadata is still
  supported as a compatibility fallback when embedded metadata is absent, but
  new setups should keep metadata in `iac.json`.
- `--reconcile-delete` reconciles selected variant files against env metadata,
  preserving current values for declared keys and removing keys that are absent
  from metadata. If metadata is absent, it warns and leaves that source file
  unchanged.
- Every key in a source folder's `.env.*` files must be declared with `key`,
  `example`, `encrypted`, and `browser` when metadata exists for that source.
- Metadata may use either `variables: [{ key, ...metadata }]` or object-map form
  such as `vars: { DATABASE_URL: { ...metadata } }`.
- Metadata may also own real env values. Use `value` for one value shared by all
  selected environments, or `values` as an object keyed by environment name such
  as `{ "staging": "...", "production": "..." }`. When any key in a source owns
  manifest values, `sync-env` generates that source's `.env.<suffix>` file from
  `iac.json`; `example` remains sample data for generated `.env.example` files.
- Metadata rows may declare `targets` to choose generated package outputs. A
  target can be an app key (`"web"`) or an object that renames the generated key,
  such as `{ "app": "web", "key": "NEXT_PUBLIC_BASE_URL" }`.
- `encrypted` controls the Vercel env var type used by `vertile-iac env`.
  `encrypted: true` writes an encrypted value; `encrypted: false` writes a plain
  value when the provider supports it.
- `browser` marks values that are safe to project into browser-facing bundles.
  Shared-prefix projection refuses to expose a key marked `browser: false`.
- `includeInExample: false` keeps a declared key out of generated
  `.env.example` files when `sync-env --write-examples` is used.
- `includeEnv` and `excludeEnv` control which real env files receive a key when
  `sync-env` populates from `.env.example`, reconciles metadata, or layers
  non-strict examples into generated package env files. The top-level
  `environments` list is the available set; stale include/exclude names outside
  that list are ignored. With only `includeEnv`, the key is populated only for
  those available environments. With only `excludeEnv`, the key is populated for
  all available environments except those listed. When both are present,
  excluded environments are removed first, then the include list is applied to
  what remains.
- Each app reads from `<env.sourceDir>/<app.key>` by default.
- Each app writes into `apps[].rootDirectory` by default.
- `apps[].env.sourceKey` and `apps[].env.outputDir` override those defaults.
- When the same key exists in shared and app-specific files, the app-specific
  value wins in generated package `.env.*` files.
- `env.sync.disallowSharedOverrides: true` changes that merge policy and rejects
  app-specific keys that would override shared keys.
- `env.sync.requiredSharedAliases` can require canonical shared keys to have
  app-prefixed aliases for apps that use `apps[].env.sharedPrefix`.
- In compatibility mode, `apps[].env.sharedPrefix` projects prefixed shared keys
  into one app, strips the prefix in that app's generated file, and keeps those
  prefixed keys out of other generated app env files.
- In direct-output mode, `sync-env --write-examples` writes `.env.example` to
  each app output directory, or to `apps[].env.examplePath` when configured.

Examples:

```json
{
  "env": {
    "sync": {
      "apps": ["landing", "web-client", "web-server"],
      "directOutputs": true
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

Example embedded env metadata:

```json
{
  "env": {
    "metadata": {
      "shared": {
        "variables": [
          {
            "key": "DATABASE_URL",
            "example": "postgres://user:password@host/db",
            "encrypted": true,
            "browser": false,
            "targets": ["web-server"],
            "values": {
              "staging": "postgres://staging-user:password@host/db",
              "production": "postgres://prod-user:password@host/db"
            }
          },
          {
            "key": "WEB_CLIENT_NEXT_PUBLIC_BASE_URL",
            "example": "https://app.example.com",
            "encrypted": false,
            "browser": true,
            "targets": [{ "app": "web-client", "key": "NEXT_PUBLIC_BASE_URL" }],
            "value": "https://app.example.com",
            "includeEnv": ["preview"],
            "excludeEnv": ["production"]
          }
        ]
      }
    }
  }
}
```

Object-map metadata:

```json
{
  "env": {
    "metadata": {
      "web": {
        "vars": {
          "DATABASE_URL": {
            "example": "postgres://user:password@host/db",
            "encrypted": true,
            "browser": false,
            "includeInExample": false
          },
          "NEXT_PUBLIC_BASE_URL": {
            "example": "https://app.example.com",
            "encrypted": false,
            "browser": true
          }
        }
      }
    }
  }
}
```

Export `.env.example` files from metadata:

```bash
vertile-iac sync-env --repo-root ../noop --write-examples --dry-run
```

Built-in local sync variants are `local`, `staging`, `preview`, `production`,
and `test`. Custom variants declared in top-level `environments` can also be selected
with `--variants`, such as `--variants=uat,nightly`.

## Shared Options

- `--repo-root <path>`: product repo root containing `infrastructure/`.
- `--iac-dir <path>`: manifest directory, default `infrastructure/iac`.
- `--project-settings <path>`: project settings manifest path.
- `--project-domains <path>`: project domains manifest path.
- `--token-file <path>`: token file, default `<repo-root>/.vercel.token`.
- `--auto-create-keys <a,b>`: project keys allowed for Vercel auto-create.
- `--auto-create-prefixes <a,b>`: project key prefixes allowed for Vercel auto-create.
- `--iac-manifest <path>`: source-of-truth IaC manifest, default `<iac-dir>/iac.json`.
- `--out <path>`: generated Terraform root, default `.vertile/terraform`.
- `--target <name|all>`: `vercel`, `aws`, `digitalocean`, or `all`.
- `--env <name>`: environment to render, plan, or apply, default `production`.
- `--deployment <name>`: provider deployment/stage name, such as `uat` or `prod`.
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
