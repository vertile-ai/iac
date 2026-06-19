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
  "version": 1,
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
  "objectStorage": [{ "key": "uploads", "visibility": "private" }],
  "databases": [{ "key": "appdb", "engine": "postgres" }],
  "queues": [{ "key": "jobs" }],
  "sandboxes": [{ "key": "runner" }],
  "clusters": [{ "key": "workers", "size": 2 }]
}
```

The schema is published as JSON Schema Draft 2020-12 at
`schema/iac.schema.json`.

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

## Vercel API Credentials

Vercel compatibility commands read API credentials from `VERCEL_TOKEN`,
`VERCEL_API_KEY`, `providers.vercel.token`, or `providers.vercel.apiKey`.
Process environment values take precedence. Manifest credentials keep the repo
`iac.json` as the local source of truth; token files remain only as a
compatibility fallback.

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

```json
{
  "providers": {
    "vercel": {
      "teamSlug": "example-team",
      "protectionBypassForAutomation": {
        "ensure": {
          "secret": "0123456789abcdefghijklmnopqrstuv",
          "note": "Playwright E2E"
        }
      }
    }
  }
}
```

Set `apps[].providers.vercel.protectionBypassForAutomation` to override the
provider-level default for one project, or set it to `false` to opt that project
out.

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
`value` may hold one real env value for all selected environments; `values` may
hold real values keyed by environment name, with optional `default`. When a
source declares manifest values, `sync-env` materializes the matching
`.env.<suffix>` source file from `iac.json` before generating package-local env
files, and `vertile-iac env` can reconcile provider env directly from the same
manifest values.
`includeEnv` and `excludeEnv` may narrow which top-level `environments` receive
a key. The top-level list is the available set, so stale include/exclude names
are ignored. Exclusions run first; inclusions then select from the remaining
environments.

Provider deployments map stage names such as `uat` or `prod` to a logical
environment plus provider-specific inputs. When a deployment is selected,
generated Terraform is written to `.vertile/terraform/<provider>/<deployment>/`,
`locals.deployment` is set, and portable provider resource names use the
deployment stage. AWS uses deployment values for region/profile/default tags,
DigitalOcean uses deployment region/version values, and Vercel uses deployment
team/teamId/teamSlug values.

## Supported Concepts

| Concept | Vercel | AWS | DigitalOcean |
| --- | --- | --- | --- |
| `apps` | Vercel Project | - | - |
| `domains` | Vercel Project Domain | - | - |
| `objectStorage` | - | S3 Bucket | Spaces Bucket |
| `databases` | - | RDS Instance | Managed Database Cluster |
| `queues` | - | SQS Queue | - |
| `sandboxes` | - | EC2 Instance | Droplet |
| `clusters` | - | EC2 Instance group | Droplet group |

Unsupported provider cells are intentionally blank. Use provider-specific
resources or another provider for those capabilities.

## Commands

Render generated Terraform:

```bash
vertile-iac render --target=all --env=production
```

Preview changes with Terraform:

```bash
vertile-iac plan --target=aws --deployment=prod
```

Apply changes with explicit non-interactive approval:

```bash
vertile-iac apply --target=aws --deployment=prod --yes
```
