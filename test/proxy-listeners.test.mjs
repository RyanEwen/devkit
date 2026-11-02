import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { acquireProxy, ensureProxy, installProxyDefinitions, proxyCompose, reconcileProxy, releaseProxy } from '../src/proxy.mjs'
import { composeDown, composeUp } from '../src/docker.mjs'
import { fetchHealth } from '../src/health-request.mjs'
import { proxyRequest, publicOrigin } from '../src/host-routing.mjs'
import { probeProjectDependencies } from '../src/project-dependencies.mjs'

const listen = (server, host, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, host, () => resolve(server.address().port))
})
const close = (server) => new Promise((resolve) => server.close(resolve))
async function eventually(check) {
  let error
  for (let attempt = 0; attempt < 30; attempt++) {
    try { return await check() } catch (caught) { error = caught }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw error
}

test('real host listeners survive missing LAN, optional bind conflicts, migration and route release', {
  skip: process.env.DEVKIT_TEST_DOCKER !== '1', timeout: 90_000
}, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'devkit-listeners-'))
  const reservation = net.createServer()
  const port = await listen(reservation, '127.0.0.1')
  await close(reservation)
  const received = []
  const backend = http.createServer((request, response) => {
    received.push({ host: request.headers.host, url: request.url })
    response.writeHead(request.url.startsWith('/health') ? 204 : 200)
    response.end('checkout')
  })
  const backendPort = await listen(backend, '127.0.0.1')
  const config = {
    configDir: directory, infraDir: path.join(directory, 'infra'), routesDir: path.join(directory, 'routes'),
    infraProject: `devkit-test-${process.pid}`, proxyNetwork: 'host', proxyBindAddress: '192.0.2.99',
    proxyPort: port, publicScheme: 'https', publicPort: 8443,
    secondaryDomains: ['unresolvable.invalid'], preferredDomain: 'unresolvable.invalid'
  }
  const identity = { slug: 'sample', hostname: 'sample.unresolvable.invalid', secondaryHostnames: ['sample.localhost'] }
  t.after(async () => {
    const compose = proxyCompose(config)
    composeDown(compose.project, compose.files, { cwd: compose.cwd, env: compose.env })
    await close(backend)
    rmSync(directory, { recursive: true, force: true })
  })
  const warnings = []
  const options = { interfaces: {}, warn: (message) => warnings.push(message) }
  // Start the pre-upgrade single-interface definition with its unavailable saved bind.
  installProxyDefinitions(config)
  mkdirSync(config.routesDir, { recursive: true })
  const oldStatic = path.join(config.infraDir, 'traefik.yml')
  writeFileSync(oldStatic, readFileSync(oldStatic, 'utf8').replace('127.0.0.1', '192.0.2.99'))
  const oldCompose = path.join(config.infraDir, 'compose.host.yml')
  writeFileSync(oldCompose, readFileSync(oldCompose, 'utf8').replace('devkit.routing-version: "2"', 'devkit.routing-version: "1"'))
  const old = proxyCompose(config)
  assert.equal(composeUp(old.project, old.files, { cwd: old.cwd, env: old.env, services: ['proxy'], wait: true }), false)
  assert.equal(acquireProxy(config, identity, backendPort, options), true)
  assert.equal(warnings.length, 2)
  const request = (url) => {
    const probe = proxyRequest(url, config)
    return fetchHealth(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(1_000) })
  }
  await eventually(async () => assert.equal((await request(publicOrigin('sample.localhost', config))).status, 200))
  const results = await probeProjectDependencies([{ name: 'sample', healthPath: '/health?q=1' }], { config })
  assert.equal(results[0].ok, true)
  assert.equal(results[0].url, 'https://sample.unresolvable.invalid:8443/health?q=1')
  assert.deepEqual(received.at(-1), { host: 'sample.unresolvable.invalid:8443', url: '/health?q=1' })

  const primaryId = () => spawnSync('docker', ['ps', '-q', '--filter',
    `label=com.docker.compose.project=${config.infraProject}`, '--filter', 'label=com.docker.compose.service=proxy'],
    { encoding: 'utf8' }).stdout.trim()
  const stablePrimary = primaryId()
  assert.ok(stablePrimary)

  // Force the optional container to bind a real unavailable interface. Its exit cannot kill IPv4.
  const compose = proxyCompose(config)
  assert.equal(composeUp(compose.project, compose.files, {
    cwd: compose.cwd, env: compose.env, services: ['proxy-lan'], wait: true
  }), false)
  assert.equal((await request(publicOrigin('sample.localhost', config))).status, 200)

  // Optional IPv6 conflicts also leave IPv4 alive; once released IPv6 can start independently.
  const blocker = net.createServer()
  try { await listen(blocker, '::1', port) } catch (error) {
    if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) throw error
    t.diagnostic('IPv6 unavailable: IPv4 already verified independently')
  }
  if (blocker.listening) {
    assert.equal(ensureProxy(config, { interfaces: { lo: [{ address: '::1' }] }, warn: options.warn }), true)
    assert.equal((await request(publicOrigin('sample.localhost', config))).status, 200)
    await close(blocker)
    assert.equal(ensureProxy(config, { interfaces: { lo: [{ address: '::1' }] }, warn: options.warn }), true)
    await eventually(async () => assert.equal((await fetchHealth(`http://[::1]:${port}/`, {
      headers: { Host: 'sample.localhost' }, signal: AbortSignal.timeout(1_000)
    })).status, 200))
  }

  // An available separate private bind starts; losing the interface removes just that listener.
  const lanConfig = { ...config, proxyBindAddress: '127.0.0.2' }
  assert.equal(ensureProxy(lanConfig, { interfaces: { lan: [{ address: '127.0.0.2' }] }, warn: options.warn }), true)
  await eventually(async () => assert.equal((await fetchHealth(`http://127.0.0.2:${port}/`, {
    headers: { Host: 'sample.localhost' }, signal: AbortSignal.timeout(1_000)
  })).status, 200))
  assert.equal(ensureProxy(lanConfig, options), true)
  await assert.rejects(fetchHealth(`http://127.0.0.2:${port}/`, { signal: AbortSignal.timeout(1_000) }))
  assert.equal((await request(publicOrigin('sample.localhost', config))).status, 200)
  assert.equal(primaryId(), stablePrimary, 'optional listeners must not recreate required IPv4')

  // Permanent old-format routes remain compatible and keep the proxy alive after lease release.
  const permanent = path.join(config.routesDir, 'devproxy-old.localhost.yml')
  writeFileSync(permanent, readFileSync(path.join(config.routesDir, 'sample.yml'), 'utf8')
    .replaceAll('sample', 'old').replace(/^# Devkit checkout owner pid:.*\n/m, ''))
  assert.equal(releaseProxy(config, identity), true)
  await eventually(async () => assert.equal((await request(publicOrigin('old.localhost', config))).status, 200))
  rmSync(permanent)
  assert.deepEqual(reconcileProxy(config), { ok: true, running: false })
  const listed = spawnSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${config.infraProject}`], { encoding: 'utf8' })
  assert.equal(listed.stdout.trim(), '')
})
