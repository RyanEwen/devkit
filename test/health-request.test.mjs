import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { fetchHealth } from '../src/health-request.mjs'

test('private readiness sends the public Host header and follows redirects without LAN DNS', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, host: request.headers.host, scheme: request.headers['x-forwarded-proto'] })
    if (request.url === '/redirect') response.writeHead(302, { Location: 'https://app.server.home/ready?ok=1' }).end()
    else response.writeHead(request.headers.host === 'app.server.home' ? 204 : 404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetchHealth(`http://127.0.0.1:${server.address().port}/redirect`, {
    headers: { Host: 'app.server.home', 'X-Forwarded-Proto': 'https' },
    redirect: 'follow', signal: AbortSignal.timeout(2000)
  })
  assert.deepEqual(response, { ok: true, status: 204 })
  assert.deepEqual(requests, [
    { path: '/redirect', host: 'app.server.home', scheme: 'https' },
    { path: '/ready?ok=1', host: 'app.server.home', scheme: 'https' }
  ])
})

test('an external login redirect cannot report a dependency as healthy', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(302, { Location: 'https://external.example/login' }).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  assert.deepEqual(await fetchHealth(`http://127.0.0.1:${server.address().port}/`, {
    headers: { Host: 'app.server.home' }, redirect: 'follow', signal: AbortSignal.timeout(2000)
  }), { ok: false, status: 302 })
})
