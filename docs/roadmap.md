# Roadmap

## Current Stable Core

The stable product boundary is deliberately narrow:

- reviewed `iac.json` infrastructure intent and JSON Schema validation;
- version 2 tracked/private value separation, including safe private-file
  handling and version 1 compatibility;
- local env sync plus Vercel env, project, and domain reconciliation;
- GitHub Actions environment publishing;
- generated Terraform, guarded plan/apply, and safe non-sensitive output.

The manifest is the only authored product-intent input. Terraform/OpenTofu is
generated provider execution, not another portable language to re-create.

## Resource Maturity

| Area | Status | Direction |
| --- | --- | --- |
| `objectStorage` | Proven | Keep the portable bucket intent small and verify provider mappings before expanding it. |
| `services` | Experimental | Validate real release-pipeline and host lifecycle needs before treating services as a stable portable abstraction. |
| `databases` | Experimental | Prove operational contracts, credentials, backups, and migrations before making a broad portability promise. |
| `queues` | Deferred | Do not claim a portable queue contract yet. |
| `sandboxes` | Deferred | Do not claim a portable sandbox or runtime contract yet. |
| `clusters` | Deferred | Do not claim a portable cluster or compute-group contract yet. |

## Near-Term Work

- Keep the version 2 private-values boundary clear in CLI behavior, schemas,
  release artifacts, and examples.
- Improve Vercel and GitHub reconciliation only through observed product needs.
- Preserve safe outputs and validation as provider integrations grow.
- Promote a resource from experimental only after it has a verified user-facing
  lifecycle and provider contract.

## Guiding Rule

Vertile AI IaC should not become Terraform, Pulumi, or Crossplane. It should
remain an app-first manifest compiler:

```text
one manifest -> focused provider adapters -> Terraform/OpenTofu execution
```

No extra Terraform abstraction layer belongs between the manifest and generated
provider code.
