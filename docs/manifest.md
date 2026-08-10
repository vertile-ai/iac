# Manifest Guide

The manifest is the source of truth for app infrastructure intent.

```text
iac.json
```

Generated Terraform is an implementation detail:

```text
.vertile/terraform/vercel/
.vertile/terraform/aws/
.vertile/terraform/digitalocean/
.vertile/terraform/<provider>/<deployment>/
```

## Minimal Manifest

```json
{
  "$schema": "./node_modules/@vertile-ai/iac/schema/iac.schema.json",
  "version": 2,
  "project": { "name": "example" },
  "environments": {
    "development": { "files": [".env.development"] },
    "uat": { "files": [".env.uat"] },
    "production": { "files": [".env.production"] }
  },
  "providers": {
    "vercel": {
      "team": "example-team",
      "deployments": {
        "uat": { "environment": "uat", "team": "example-team" },
        "prod": { "environment": "production", "team": "example-team" }
      }
    },
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
    "digitalocean": {
      "region": "nyc3",
      "deployments": {
        "uat": { "environment": "uat", "region": "nyc3" },
        "prod": { "environment": "production", "region": "nyc3" }
      }
    }
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
  "domains": [],
  "objectStorage": [{ "key": "uploads", "visibility": "private" }]
}
```

The tracked-manifest schema is published as JSON Schema Draft 2020-12 at
`schema/iac.schema.json`. Version 2 private values use the separate
`schema/iac.private.schema.json` document.

## Version 2 Strict Split

Version 2 keeps the tracked manifest reviewable. `iac.json` contains
infrastructure intent, env metadata, and non-secret env values. Encrypted env
metadata must not define inline `value` or `values`, and tracked Vercel/GitHub
credentials or Vercel automation-bypass secrets are rejected.

Private values default to `.vertile-iac/private.json`. This is a strict,
allowlisted document rather than an arbitrary manifest overlay:

```json
{
  "version": 1,
  "env": {
    "web": {
      "DATABASE_URL": {
        "production": "<private database URL>"
      }
    }
  },
  "providers": {
    "vercel": {
      "apiKey": "<private Vercel API key>",
      "protectionBypassForAutomation": {
        "ensure": { "secret": "<private bypass secret>" }
      }
    },
    "github": { "token": "<private GitHub token>" }
  }
}
```

The env shape is `env.<source>.<variable>.<environment>`. Private env entries
may supply only encrypted metadata keys declared by the public manifest. The
provider allowlist is `providers.vercel.token`, `providers.vercel.apiKey`,
`providers.vercel.protectionBypassForAutomation.ensure.secret`, and
`providers.github.token`.

In a Git worktree, `.vertile-iac/private.json` must be ignored and untracked.
On POSIX, use mode `0600`; group- or world-readable files are rejected. The
Terraform renderer never reads this file, so private values cannot alter
rendered Terraform.

Credential precedence is provider-specific. Vercel uses process
`VERCEL_TOKEN`/`VERCEL_API_KEY`, then private Vercel credentials, then version
1 inline values, then the legacy token file. GitHub Actions uses process
`GH_TOKEN`/`GITHUB_TOKEN`, then `private.json` `providers.github.token`, then
version 1 `providers.github.token` or `providers.githubActions.token`; it has
no token-file fallback. Version 1 keeps its inline env and credential behavior.

## Provider Overrides

Portable concepts should be shared by default, with provider-specific overrides
only where the provider really differs.

```json
{
  "objectStorage": [
    {
      "key": "assets",
      "visibility": "private",
      "providers": {
        "aws": { "storageClass": "standard" },
        "digitalocean": { "region": "nyc3" }
      }
    }
  ]
}
```

DigitalOcean Spaces bucket names are DNS-safe by construction. Generated names
use lowercase dashes, and an explicit `providers.digitalocean.name` or
`providers.digitalocean.bucket` must be 3–63 characters using only lowercase
letters, digits, and dashes. This matches DigitalOcean's global bucket naming
rules and prevents a render that can never pass Terraform validation.

## Object Storage

`objectStorage` is a portable bucket intent. DigitalOcean renders it as a
Spaces bucket with a private ACL by default. Set `visibility` to `public` for
the provider's `public-read` ACL, or use the provider override for an explicit
bucket name and region:

```json
{
  "objectStorage": [
    {
      "key": "uploads",
      "visibility": "private",
      "providers": {
        "digitalocean": {
          "name": "example-uploads",
          "region": "syd1",
          "acl": "private"
        }
      }
    }
  ]
}
```

DigitalOcean renders non-sensitive outputs for each bucket: bucket name,
regional endpoint, bucket domain name, and region. Runtime access keys are
never emitted by the manifest or Terraform output; supply
`SPACES_ACCESS_KEY_ID` and `SPACES_SECRET_ACCESS_KEY` through the Terraform
provider environment.

## Services

`services` are experimental. The current renderer supports a narrow,
deployable baseline: public container services on DigitalOcean single Droplets.

```json
{
  "apps": [{ "key": "api", "name": "example-api" }],
  "services": [
    {
      "key": "api",
      "app": "api",
      "runtime": "container",
      "port": 3000,
      "public": true,
      "replicas": 1,
      "healthCheck": { "path": "/health" },
      "providers": {
        "digitalocean": {
          "mode": "droplet",
          "region": "sfo3",
          "sizeSlug": "s-1vcpu-2gb",
          "image": "ubuntu-24-04-x64",
          "backups": true,
          "monitoring": true,
          "reservedIp": true
        }
      }
    }
  ]
}
```

Portable service fields:

| Field | Default | Notes |
| --- | --- | --- |
| `key` | required | Stable service identifier. Keys must be unique and must not collide after Terraform name sanitization. |
| `app` | optional | Must reference an `apps[].key` when set. |
| `runtime` | required | Must be `container` in v1. |
| `port` | required | Internal application/upstream port, integer `1` to `65535`. This is not opened publicly by the generated firewall. |
| `public` | `true` | v1 supports public services only; `false` is rejected. |
| `replicas` | `1` | v1 supports one replica only; values other than `1` are rejected. |
| `healthCheck.path` | optional | Absolute path beginning with `/`. It is emitted as rollout metadata and an output when set. |
| `protocol` | unsupported | Rejected in v1. The release pipeline/reverse proxy owns HTTP, HTTPS, and WSS routing. |

DigitalOcean service provider fields:

| Field | Default | Notes |
| --- | --- | --- |
| `mode` | `droplet` | v1 supports Droplets only; any other value is rejected. |
| `region` | selected deployment region, then provider region | Required from one of service, deployment, or provider config. |
| `sizeSlug` or `size` | `s-1vcpu-2gb` | Droplet size used for first-class services. |
| `image` | `ubuntu-24-04-x64` | Base host image. |
| `backups` | `true` | DigitalOcean Droplet backup flag. |
| `monitoring` | `true` | DigitalOcean Droplet monitoring flag. |
| `reservedIp` | `true` | Required for public v1 services; `false` is rejected. |
| `sshKeyFingerprints` | omitted | DigitalOcean SSH key fingerprints to install on the Droplet. Omit in shared examples unless real management access is intended. |
| `managementCidrs` | omitted | Explicit SSH CIDR allowlist. Empty, duplicate, invalid, or global CIDRs such as `0.0.0.0/0` and `::/0` are rejected. |

### DigitalOcean Service Lifecycle

For a DigitalOcean service, `render`, `plan`, and `apply` produce a secure empty
host. The generated Terraform creates:

- a `digitalocean_project` for services;
- one `digitalocean_droplet` per service;
- a `digitalocean_reserved_ip` and assignment;
- a `digitalocean_firewall`;
- cloud-init bootstrap for Docker, disabled password/root SSH login, non-root
  `vertile` user, `/srv/vertile/<service_key>`, and
  `/var/lib/vertile-iac/bootstrap-complete`.

It intentionally does not build or push application images, configure GHCR,
write runtime secrets, configure DNS, issue TLS certificates, start a running
app, or prove HTTP health/WSS behavior.

The consumer release pipeline owns:

- image build and publishing, for example to GHCR;
- runtime secret delivery;
- binding the application to localhost on `services[].port`;
- reverse proxy and TLS configuration on `80`/`443`;
- health and WSS proof using service outputs;
- rollout and rollback.

The firewall model is conservative. Public ingress is only `80` and `443`. The
application port is private upstream metadata and is not exposed globally. SSH
port `22` is rendered only when `managementCidrs` is explicitly set. Do not use
GitHub-hosted runner egress as a Terraform firewall allowlist because those
source addresses are not stable enough for a durable rule set. Prefer fixed
egress, self-hosted runners, private networking, or a pull-based deployment
agent over firewall churn.

### DigitalOcean Service Outputs

First-class DigitalOcean services emit stable Terraform output names:

| Output | Value |
| --- | --- |
| `digitalocean_service_<service_key>_droplet_id` | Droplet id. |
| `digitalocean_service_<service_key>_reserved_ip` | Reserved IP address. |
| `digitalocean_service_<service_key>_public_host` | Public host value; currently the Reserved IP address. |
| `digitalocean_service_<service_key>_ssh_user` | `vertile`. |
| `digitalocean_service_<service_key>_application_directory` | `/srv/vertile/<service_key>`, using Terraform-safe sanitized service key text. |
| `digitalocean_service_<service_key>_application_port` | The manifest `services[].port`. |
| `digitalocean_service_<service_key>_health_check_path` | The manifest `healthCheck.path`, only when set. |

Use the output command for release automation:

```bash
vertile-iac output --target=digitalocean --deployment=prod --json
```

The JSON envelope is stable:

```json
{
  "target": "digitalocean",
  "deployment": "prod",
  "environment": "production",
  "outputs": {
    "digitalocean_service_api_public_host": "203.0.113.10",
    "digitalocean_service_api_ssh_user": "vertile",
    "digitalocean_service_api_application_directory": "/srv/vertile/api",
    "digitalocean_service_api_application_port": 3000,
    "digitalocean_service_api_health_check_path": "/health"
  }
}
```

## Vercel API Credentials

For version 2, Vercel API credentials belong in the process environment or
`.vertile-iac/private.json`, not in tracked `iac.json`. Resolution is process
`VERCEL_TOKEN`/`VERCEL_API_KEY`, then private `providers.vercel.token` or
`providers.vercel.apiKey`, then version 1 inline values, then the legacy token
file. The private-document checks apply to every Vercel command that resolves a
private file.

## Vercel Automation Bypass

Vercel automation bypass secrets are project protection configuration. They are
not application runtime environment variables, so do not model them under
`env.metadata` unless a deployed app must read the value.

Use `providers.vercel.protectionBypassForAutomation.ensure` for repeatable
sync. Vertile AI IaC treats `note` as the unique identifier by exact match,
reads the Vercel project `protectionBypass` metadata, and then sends the
provider API operation:

- `update` when exactly one existing automation bypass has the same note.
- `generate` when no automation bypass has that note.
- an error when Vercel does not expose protection-bypass note metadata or when
  the note matches more than one bypass.

Public version 2 intent contains the stable note:

```json
{
  "providers": {
    "vercel": {
      "teamSlug": "example-team",
      "protectionBypassForAutomation": {
        "ensure": {
          "note": "Playwright E2E"
        }
      }
    }
  }
}
```

The paired private document supplies only the secret:

```json
{
  "version": 1,
  "providers": {
    "vercel": {
      "protectionBypassForAutomation": {
        "ensure": { "secret": "<private bypass secret>" }
      }
    }
  }
}
```

Version 2 permits this private `ensure.secret` shape only. Direct tracked
secrets for `ensure`, `generate`, `update`, or `revoke` are rejected. Version 1
keeps the inline compatibility shapes.

Set `apps[].protectionBypassForAutomation` or
`apps[].providers.vercel.protectionBypassForAutomation` to override the
provider-level default for one project, or set it to `false` to opt that project
out.

## Vercel Project Settings

`framework`, `installCommand`, `buildCommand`, and `outputDirectory` are
managed only when explicitly declared. Set a project-wide default in
`providers.vercel.projectDefaults` (or the compatibility alias
`projectSettingsDefaults`), then override it on an app or
`apps[].providers.vercel`. An undeclared field is not included in the Vercel
PATCH request, so an existing remote value is preserved.

Explicit legacy `--project-settings` input remains a compatibility path. When
the unified manifest is version 2, its root/default/project bypass entries must
not contain any `protectionBypassForAutomation.*.secret` field.

## Escape Hatch

Provider-specific Terraform resources can be expressed under
`providers.<target>.resources` while the portable schema matures.

```json
{
  "providers": {
    "aws": {
      "resources": [
        {
          "type": "aws_s3_bucket",
          "name": "assets",
          "values": {
            "bucket": "example-assets"
          }
        }
      ]
    }
  }
}
```

Use this as a bridge, not as the primary authoring model. The long-term goal is
to promote common patterns into first-class portable concepts.

## Environments And Deployments

Top-level environments define the logical environment names used by remote
infrastructure and local env sync. They may be an array of names or an object
whose values define env file selection. By default, env sources live in
`.vertile-iac/env/shared` and `.vertile-iac/env/<app-key>`.

Env metadata is authored in the same manifest under `env.metadata.<source-key>`.
Each source key maps to a source folder such as `shared`, `web`, or `api`, and
declares every managed key with `example`, `encrypted`, and `browser`.
An optional `description` is rendered as an adjacent comment in generated
`.env.example` files. With direct outputs enabled, package examples are always
maintained by `sync-env`; omit `--variants` to sync the declared environments
in manifest order.
For version 1, `value` may hold one real env value for all selected
environments; `values` may hold real values keyed by environment name, with
optional `default`. In version 2, this remains available for non-encrypted
metadata only. Encrypted metadata values are resolved from `private.json` at
`env.<source>.<variable>.<environment>`. When a source declares allowed
manifest values, `sync-env` materializes the matching `.env.<suffix>` source
file from `iac.json` before generating package-local env files, and
`vertile-iac env` can reconcile provider env directly from the same manifest
values.
`includeEnv` and `excludeEnv` may narrow which top-level `environments` receive
a key. The top-level list is the available set, so stale include/exclude names
are ignored. Exclusions run first; inclusions then select from the remaining
environments.

Run `vertile-iac validate` before sync or CI to check direct-output value
coverage, package routes, browser-safe projections, output collisions, and
ignored encrypted target paths. It is offline and read-only.

Provider deployments map stage names such as `uat` or `prod` to a logical
environment plus provider-specific inputs. When a deployment is selected,
generated Terraform is written to `.vertile/terraform/<provider>/<deployment>/`,
`locals.deployment` is set, and portable provider resource names use the
deployment stage. AWS uses deployment values for region/profile/default tags,
DigitalOcean uses deployment region/version values, and Vercel uses deployment
team/teamId/teamSlug values.

## DigitalOcean Backend

DigitalOcean uses local Terraform state by default. Optional remote state is a
Spaces-backed S3-compatible Terraform backend:

```json
{
  "providers": {
    "digitalocean": {
      "region": "sfo3",
      "backend": {
        "type": "spaces",
        "bucket": "terraform-state",
        "region": "sfo3"
      },
      "deployments": {
        "prod": {
          "environment": "production",
          "region": "sfo3",
          "stateKey": "bun-hono-api/prod/terraform.tfstate"
        }
      }
    }
  }
}
```

The bucket must already exist. Backend credentials are never read from the
manifest and credential-like backend fields are rejected. Export
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for Terraform because the
DigitalOcean Spaces backend is rendered through Terraform's S3 backend.

Remote state requires selecting a deployment whose values include `stateKey`.
The key must be a safe relative object key: ASCII letters, digits, `.`, `_`,
`-`, and `/`, with no leading slash, trailing slash, empty segment, `.`, or
`..` segment.

Current generated backend model:

```hcl
terraform {
  required_version = "~> 1.11"

  backend "s3" {
    endpoints = {
      s3 = "https://sfo3.digitaloceanspaces.com"
    }
    bucket                      = "terraform-state"
    key                         = "bun-hono-api/prod/terraform.tfstate"
    region                      = "us-east-1"
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    use_lockfile                = true
  }
}
```

`useLockfile` defaults to `true` and renders `required_version = "~> 1.11"` plus
`use_lockfile = true`. Set `useLockfile: false` only for Terraform `>= 1.6.3`
compatibility; that omits `use_lockfile`.

Backend lifecycle flags are explicit:

- `--migrate-state` runs `terraform init -migrate-state -force-copy`.
- `--reconfigure` runs `terraform init -reconfigure`.
- The two flags are mutually exclusive.
- State migration is never automatic.

## DigitalOcean Provider Version

Generated DigitalOcean Terraform pins `digitalocean/digitalocean` to `2.96.0`
by default:

```json
{
  "providers": {
    "digitalocean": {
      "region": "sfo3",
      "version": "2.96.0"
    }
  }
}
```

Override the pin with `providers.digitalocean.version`, or with
`providers.digitalocean.deployments.<name>.version` for one deployment.

When updating the default pin, verify the official DigitalOcean Terraform
provider documentation and release notes first, then update the default,
provider-version tests, affected generated fixtures or docs, and a changeset in
the same PR.

## Product Scope

| Area | Status |
| --- | --- |
| Env metadata and sync, Vercel reconciliation, GitHub Actions, validation, safe non-sensitive output | Stable core |
| `objectStorage` | Proven portable resource |
| `services`, `databases` | Experimental |
| `queues`, `sandboxes`, `clusters` | Deferred |

Provider-specific `resources` are an escape hatch, not a promise that every
portable-looking concept has a stable provider mapping. Vertile IaC does not
add another abstraction layer over Terraform; generated Terraform remains the
provider execution contract.

## Commands

Render generated Terraform:

```bash
vertile-iac render --target=all --env=production
vertile-iac render --target=digitalocean --deployment=prod
```

Preview changes with Terraform:

```bash
vertile-iac plan --target=aws --deployment=prod
```

Apply changes with explicit non-interactive approval:

```bash
vertile-iac apply --target=aws --deployment=prod --yes
```

Print non-sensitive Terraform outputs as JSON:

```bash
vertile-iac output --target=digitalocean --deployment=prod --json
```
