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

- The authored manifest is `infrastructure/iac/iac.json`.
- Examples and product repos should prefer unified `iac.json`; legacy
  `env-manifest.json`, `project-settings.json`, and `project-domains.json`
  exist only for explicit compatibility inputs.
- Env metadata belongs in `iac.json` under `env.metadata.<source-key>`.
  Per-source `.env.json` files are compatibility fallback only and should not be
  introduced for new setups.
- Env source files live under `env.sourceDir`, defaulting to `.vertile-iac/env`.
  Monorepos use one metadata object per source folder, for example
  `env.metadata.shared`, `env.metadata.web-client`, or `env.metadata.api`.
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
