# Go API

Go HTTP backend example with AWS and DigitalOcean targets.

```bash
vertile-iac render --repo-root examples/go-api --target=all --env=production
vertile-iac render --repo-root examples/go-api --iac-manifest infrastructure/iac/iac.do.json --target=digitalocean --env=production
```
