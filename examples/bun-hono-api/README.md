# Bun Hono API

Bun backend example using Hono-style project structure with an explicit
DigitalOcean variant.

```bash
vertile-iac render --repo-root examples/bun-hono-api --target=all --env=production
vertile-iac render --repo-root examples/bun-hono-api --iac-manifest infrastructure/iac/iac.do.json --target=digitalocean --env=production
```
