# SvelteKit Web

SvelteKit app example with Vercel as the primary web provider and a
DigitalOcean variant for infrastructure resources.

```bash
vertile-iac render --repo-root examples/sveltekit-web --target=all --env=production
vertile-iac render --repo-root examples/sveltekit-web --iac-manifest infrastructure/iac/iac.vercel.json --target=vercel --env=production
```
