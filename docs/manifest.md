# Manifest Guide

The manifest is the source of truth for app infrastructure intent.

```text
infrastructure/iac/iac.json
```

Generated Terraform is an implementation detail:

```text
.vertile/terraform/vercel/
.vertile/terraform/aws/
.vertile/terraform/digitalocean/
```

## Minimal Manifest

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
vertile-iac plan --target=aws --env=production
```

Apply changes with explicit non-interactive approval:

```bash
vertile-iac apply --target=aws --env=production --yes
```
