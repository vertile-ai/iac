import http from 'node:http'

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true, runtime: 'node' }))
})

server.listen(process.env.PORT || 3000)
