# Node API

Single-package Node.js HTTP API example with AWS and DigitalOcean targets.

```bash
vertile-iac render --repo-root examples/node-api --target=all --env=production
vertile-iac render --repo-root examples/node-api --iac-manifest infrastructure/iac/iac.aws.json --target=aws --env=production
```
