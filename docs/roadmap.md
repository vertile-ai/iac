# Roadmap

## Phase 1: Stable Compiler Core

- Keep `infrastructure/iac/iac.json` as the only user-authored source of truth.
- Render provider-specific Terraform into `.jazelly/terraform/<provider>/`.
- Keep legacy Vercel API reconciliation working until the Terraform path is
  verified.
- Support `render`, `plan`, and guarded `apply`.
- Add schema validation with clear errors.

## Phase 2: First-Class Resource Concepts

Move provider-specific escape hatches behind portable app infrastructure
concepts:

- `apps`
- `domains`
- `env`
- `objectStorage`
- `databases`
- `queues`
- `sandboxes`
- `clusters`

Each concept should have shared fields and optional provider overrides.

Current implementation status:

- `apps` and `domains` render to Vercel resources.
- `objectStorage` renders to AWS S3 and DigitalOcean Spaces.
- `databases` renders to AWS RDS and DigitalOcean Managed Databases.
- `queues` renders to AWS SQS.
- `sandboxes` and `clusters` render to AWS EC2 instances and DigitalOcean
  Droplets.

## Phase 3: Provider Matrix

Initial providers:

- Vercel: apps, domains, env vars, project settings.
- AWS: S3, RDS or DynamoDB, SQS, Lambda or ECS, EC2 where needed.
- DigitalOcean: Spaces, Managed Databases, App Platform, Droplets, Kubernetes
  where needed.

Likely later providers:

- Cloudflare for DNS, Workers, R2, and queues.
- Neon and Supabase for databases.
- Fly.io, Render, and Railway for app hosting.
- Modal, E2B, and Daytona for sandbox or runtime providers.
- Hetzner and Vultr for cheaper compute and clusters.

## Phase 4: AI-Native Workflow

- `jazelly-iac explain`: explain a manifest in product language.
- `jazelly-iac doctor`: detect unsupported mappings, missing credentials, and
  risky settings.
- `jazelly-iac migrate`: suggest moves between providers.
- Plan summaries that say what changes mean, not just what Terraform will do.

## Phase 5: State And Outputs

- Use local state by default.
- Support optional remote backend configuration later.
- Add drift detection through `plan`.
- Write provider outputs to `.jazelly/outputs/<env>.json`.

## Guiding Rule

Jazelly IaC should not become Terraform, Pulumi, or Crossplane.

It should stay focused on app-first portable infrastructure intent:

```text
one manifest -> provider adapters -> Terraform/OpenTofu execution
```
