# Jazelly IaC Docs

Jazelly IaC is an app-first infrastructure abstraction for solo builders and
small teams. Define infrastructure intent once, then compile it into
provider-specific infrastructure without adopting Kubernetes as a control plane.

## Start Here

- [Positioning](./positioning.md)
- [Roadmap](./roadmap.md)
- [Manifest Guide](./manifest.md)
- [Static Website](./index.html)

## Core Idea

Crossplane is Kubernetes-first platform infrastructure.
Terraform and OpenTofu are provider-specific execution engines.
Jazelly IaC is app-first portable infrastructure intent.

The user-authored source of truth is:

```text
infrastructure/iac/iac.json
```

Generated Terraform lives under:

```text
.jazelly/terraform/<provider>/
```

Users edit the manifest. Jazelly IaC renders provider-specific infrastructure.

## Commands

```bash
jazelly-iac render --target=all --env=production
jazelly-iac plan --target=aws --env=production
jazelly-iac apply --target=aws --env=production --yes
```
