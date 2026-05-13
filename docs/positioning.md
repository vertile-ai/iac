# Positioning

Jazelly IaC is for developers who want portable infrastructure intent without
operating a platform control plane.

## Why This Exists

In the AI era, more products are built by one-person companies and very small
teams. Collaboration overhead matters less than abstraction quality. A single
developer, or an AI working with that developer, should not need to hand-author
different infrastructure definitions for every provider.

Jazelly IaC provides one manifest for app infrastructure needs:

- app hosting
- domains
- environment variables and secrets
- object storage
- databases
- queues
- sandboxes and runtimes
- clusters and compute

Provider adapters compile those needs into Vercel, AWS, DigitalOcean, and later
other providers.

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

Jazelly IaC takes a different position:

```text
Crossplane:
  Kubernetes as the infrastructure control plane.

Jazelly IaC:
  Git repo + CLI as the infrastructure control surface.
```

## Terraform And OpenTofu

Terraform and OpenTofu are execution engines, not portable abstractions.
Terraform can manage many providers, but provider resources are not portable by
themselves. An AWS S3 bucket resource is not the same as a DigitalOcean Spaces
resource or a Cloudflare R2 resource.

Jazelly IaC treats Terraform/OpenTofu files as generated output. The portable
source of truth is the manifest.
