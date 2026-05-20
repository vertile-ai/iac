import { Hono } from 'hono'

const app = new Hono()

app.get('/health', (context) => context.json({ ok: true, runtime: 'bun' }))

export default app
