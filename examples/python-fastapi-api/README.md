# Python FastAPI API

Python backend example with PostgreSQL and provider-specific AWS settings.

```bash
vertile-iac render --repo-root examples/python-fastapi-api --target=all --env=production
vertile-iac render --repo-root examples/python-fastapi-api --iac-manifest infrastructure/iac/iac.aws.json --target=aws --env=production
```
