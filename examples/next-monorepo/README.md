# Next.js Monorepo

This fixture shows a two-app Next.js monorepo from the shape a product repo
would keep. It intentionally uses the full current manifest surface: multiple
Vercel apps, domains, preview/production env provisioning, local env sync,
portable storage/database/queue/compute concepts, provider overrides, and
provider-specific escape hatch resources.

It intentionally contains no real secrets. The env files use placeholder values
so package consumers can inspect and run dry-runs without extra setup.

## Commands

```bash
vertile-iac sync-env --repo-root examples/next-monorepo --variants=staging,production
vertile-iac env --repo-root examples/next-monorepo --targets=preview,production
vertile-iac projects --repo-root examples/next-monorepo --projects=web
vertile-iac domains --repo-root examples/next-monorepo --projects=web
vertile-iac render --repo-root examples/next-monorepo --target=all --env=production
```

Apply commands require `VERCEL_TOKEN` and a real Vercel team/project.
