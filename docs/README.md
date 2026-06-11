# Vertile AI IaC Docs

Vertile AI IaC is an app-first infrastructure abstraction for solo builders and
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
Vertile AI IaC is app-first portable infrastructure intent.

The user-authored source of truth is:

```text
infrastructure/iac/iac.json
```

Env sync and Vercel compatibility metadata are also authored in this manifest
under top-level `environments`, `env.sourceDir`, `env.sync`, and
`env.metadata.<source-key>`.

Generated Terraform lives under:

```text
.vertile/terraform/<provider>/
.vertile/terraform/<provider>/<deployment>/
```

Users edit the manifest. Vertile AI IaC renders provider-specific infrastructure.

## Commands

```bash
vertile-iac render --target=all --env=production
vertile-iac plan --target=aws --deployment=prod
vertile-iac apply --target=aws --deployment=prod --yes
```
