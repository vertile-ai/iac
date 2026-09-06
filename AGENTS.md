<!-- codex-memory-builder:start -->
## Personal Codex Memory

Before starting work, read and follow:

/Users/jazelly/.codex/memories/personal-codex-memory.md

This document contains long-term execution lessons, UI/product preferences,
interaction principles, and reusable behavior rules. Unless the user explicitly
overrides it, future Codex sessions should treat it as standing guidance.
<!-- codex-memory-builder:end -->

# Vertile IaC Project Rules

This repository owns `@vertile-ai/iac`: a manifest-first infrastructure CLI for
portable app infrastructure, local env file sync, and Vercel compatibility
commands.

## Source Of Truth

- New projects use root `iac.json` with manifest version `2`. The legacy
  `infrastructure/iac/iac.json` location and version `1` are compatibility
  inputs, not the authoring default. `env-manifest.json`,
  `project-settings.json`, and `project-domains.json` are explicit compatibility
  inputs only.
- `iac.json` owns infrastructure intent, env metadata, non-secret values, and
  provider-neutral credential declarations. `.iac/` supplements the manifest;
  it does not replace it.
- Private values live in `.iac/private.json` (document version `1`) at
  `env.<source>.<variable>.<environment>` and
  `credentials.<id>.<environment>`. This file must be ignored, untracked, and
  mode `0600` on POSIX. Encrypted metadata must not define inline `value` or
  `values`, and examples must contain only safe placeholders.
- Credential consumers own `{ id, environment }` references and delivery.
  Private values are runtime strings; the CLI does not decrypt legacy envelopes.
- `init` creates both files. For an existing v2 manifest, `scaffold` preserves
  manifest bytes, adds missing private slots without overwriting existing values,
  and creates `~/.iac/repositories/github/<owner>/<repo>/` plus declared Terraform
  stack/environment directories. `context` reads this repository identity and
  returns paths without exposing private values.
- Env metadata belongs only in `iac.json` under `env.metadata.<source-key>`.
- Env source files live under `env.sourceDir`, defaulting to `.vertile-iac/env`.
  Monorepos use one metadata object per source folder, for example
  `env.metadata.shared`, `env.metadata.web-client`, or `env.metadata.api`.
- In direct-output mode, metadata and private values generate package `.env*`
  files directly; the source directory is not an additional secret authority.
- `init` declares `local`, `staging`, and `production`. Projects may explicitly
  declare other environments; `test` is not an implicit IaC environment.
- After filling private slots, run `validate` (offline, read-only), then
  `sync-env` for application env output. Credential changes do not require
  application env sync. Provider reconciliation needs an explicit apply command.
- `includeEnv` and `excludeEnv` are intersected with the top-level
  `environments` list. Exclusions are applied first, then inclusions are applied
  to the remaining set.

## Development

- Keep changes scoped to the requested behavior and the existing CLI patterns.
- Add focused node tests for behavior changes before production code changes.
- Run `node --test` or the smallest relevant test first, then run `npm test` and
  `npm run check` before claiming completion when the change touches CLI
  behavior, schema, docs examples, or sync behavior.
- When env source files or metadata in a linked product repo change, run that
  repo's env sync script, usually `pnpm env:sync`.

## Git workflow

- Pull requests into `main` must use **rebase and merge**. Do not use GitHub's
  merge-commit strategy, so `main` remains a linear history.
