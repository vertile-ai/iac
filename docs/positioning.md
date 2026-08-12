# Positioning

Vertile AI IaC is for developers who want portable infrastructure intent without
operating a platform control plane or replacing Terraform with another general
purpose language.

## Why This Exists

In the AI era, more products are built by one-person companies and very small
teams. Collaboration overhead matters less than abstraction quality. A single
developer, or an AI working with that developer, should not need to hand-author
different infrastructure definitions for every provider.

The stable core is a reviewed manifest, env metadata and sync, Vercel and
GitHub reconciliation, validation, and safe non-sensitive output. Version 2
keeps tracked intent and private values separate so a repository can review
infrastructure without committing secrets.

Object storage is the proven portable resource today. Services and databases
are experimental. Queues, sandboxes, and clusters are deferred rather than
presented as stable cross-provider promises. Provider adapters should grow from
verified user needs, not from a speculative provider matrix.

## Crossplane Comparison

Crossplane is a strong reference point, but it makes Kubernetes the control
plane. Your app does not have to run on Kubernetes to use Crossplane, but the
Crossplane controllers do.

That is powerful for platform teams that need:

- RBAC
- audit logs
- CRDs
- admission policies
- namespaces
- Kubernetes secrets
- continuous controllers

Those are mostly developer-platform collaboration features. They are valuable
inside larger engineering organizations, but heavy for solo builders and small
teams that only want app infrastructure.

Vertile AI IaC takes a different position:

```text
Crossplane:
  Kubernetes as the infrastructure control plane.

Vertile AI IaC:
  Git repo + CLI as the infrastructure control surface.
```

## Terraform And OpenTofu

Terraform and OpenTofu are execution engines, not portable abstractions.
Terraform can manage many providers, but provider resources are not portable by
themselves. An AWS S3 bucket resource is not the same as a DigitalOcean Spaces
resource or a Cloudflare R2 resource.

Vertile AI IaC treats Terraform/OpenTofu files as generated output. The portable
source of truth is the manifest. It intentionally does not add a second
Terraform-like abstraction layer: provider-specific Terraform remains the
execution contract, while the manifest stays limited to product intent that is
actually supported.
