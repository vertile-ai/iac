# Bun Hono API

Bun backend example using Hono-style project structure with an explicit
DigitalOcean variant.

```bash
vertile-iac render --repo-root examples/bun-hono-api --target=all --deployment=prod
vertile-iac render --repo-root examples/bun-hono-api --iac-manifest iac.do.json --target=digitalocean --deployment=prod
```

The DigitalOcean-specific manifest renders infrastructure only: a project,
Droplet, Reserved IP, firewall, Docker bootstrap, non-root `vertile` user,
application directory, and bootstrap readiness marker. It does not build or push
the Bun image, install runtime secrets, configure DNS/TLS, start the app, or
prove `/health`.

The release pipeline that consumes the rendered outputs owns GHCR/image
publishing, secret delivery, binding the app to localhost port `3000`, reverse
proxy/TLS, health and WSS checks, rollout, and rollback.
