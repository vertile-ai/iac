# @vertile-ai/iac

## 0.3.0

### Minor Changes

- fea45de: Document DigitalOcean service hosts, Spaces backend state, stable output JSON, and the runnable Bun Hono service example.
- fea45de: Make `iac.json env.metadata` the sole env metadata source, removing legacy per-source `.env.json` and `metadataFile` compatibility while retaining manifest-driven env sync defaults, described package examples, and offline environment validation.
- a74fe99: Add version 2 tracked/private value separation under `.iac/private.json`, `init` and `scaffold` commands for new and existing manifests, safe local example fallback, private schema distribution, Vercel and GitHub credential resolution, and explicit Vercel build-setting reconciliation.

### Patch Changes

- fea45de: Stop treating `.env.test` as a default environment file during env sync.
- fea45de: Generate DNS-safe object-storage bucket names and reject invalid DigitalOcean Spaces bucket overrides and state buckets.

## 0.2.1

### Patch Changes

- 16c779c: Improve Vercel and GitHub CLI failure diagnostics, use the current Vercel project creation endpoint, and add contract-based remote API failure tests.

## 0.2.0

### Minor Changes

- b3838e8: Support note-keyed Vercel protection bypass automation and synced schema docs.

### Patch Changes

- e900fb4: Add Changesets release automation for npm publishing from GitHub Actions.
- 65f441b: Migrate the CLI implementation to TypeScript, publish compiled ESM, and enforce coverage checks in the test workflow.
