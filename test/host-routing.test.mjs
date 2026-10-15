import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { deriveCheckoutIdentity, checkoutPorts } from '../src/checkout-identity.mjs'
import { checkoutOrigins, normalizeHostRouting, proxyHostnames, proxyRequest, publicOrigin } from '../src/host-routing.mjs'
import { bootstrapSettings, nginxConfig, traefikConfig } from '../src/host-setup.mjs'
import { dependencyOrigins, probeProjectDependencies } from '../src/project-dependencies.mjs'
import { proxyCompose } from '../src/proxy.mjs'

const remote = {
  secondaryDomains: ['server.home'], preferredDomain: 'server.home',
  proxyPort: 18080, publicPort: 80,
  proxyNetwork: 'host', proxyBindAddress: '172.24.0.1'
}
const checkout = {
  root: '/work/app', toplevel: '/work/app', gitDir: '.git', gitCommonDir: '.git'
}

test('the default machine retains localhost, HTTP, and port 80', () => {
  const config = normalizeHostRouting()
  assert.equal(config.domain, 'localhost')
  assert.equal(config.preferredDomain, 'localhost')
  assert.deepEqual(config.secondaryDomains, [])
  assert.equal(publicOrigin('app.localhost', config), 'http://app.localhost')
})

test('secondary domains add aliases without changing checkout resources or the default origin', () => {
  const original = deriveCheckoutIdentity(checkout)
  const secondary = deriveCheckoutIdentity(checkout, { secondaryDomains: ['server.home'] })
  assert.equal(secondary.hostname, original.hostname)
  assert.deepEqual(secondary.secondaryHostnames, ['app.server.home'])
  const preferred = deriveCheckoutIdentity(checkout, remote)
  assert.equal(preferred.hostname, 'app.server.home')
  assert.deepEqual(preferred.secondaryHostnames, ['app.localhost'])
  for (const key of ['slug', 'composeProject', 'databaseName']) assert.equal(preferred[key], original[key])
  assert.deepEqual(checkoutPorts(preferred), checkoutPorts(original))
  assert.deepEqual(checkoutOrigins(preferred, remote), ['http://app.server.home', 'http://app.localhost'])
})

test('worktree aliases preserve the nested project naming', () => {
  const identity = deriveCheckoutIdentity({
    ...checkout, gitDir: '/work/app/.git/worktrees/fix', gitCommonDir: '/work/app/.git'
  }, remote)
  assert.equal(identity.hostname, 'fix.app.server.home')
  assert.deepEqual(identity.secondaryHostnames, ['fix.app.localhost'])
})

test('browser scheme and port are independent of Traefik and numeric API arguments still work', () => {
  assert.equal(publicOrigin('app.server.home', remote), 'http://app.server.home')
  assert.equal(publicOrigin('app.localhost', 8080), 'http://app.localhost:8080')
  assert.equal(publicOrigin('app.server.home', { ...remote, publicScheme: 'https', publicPort: 443 }), 'https://app.server.home')
  assert.equal(publicOrigin('app.server.home', { ...remote, publicScheme: 'https', publicPort: 8443 }), 'https://app.server.home:8443')
})

test('bootstrap preserves routing preferences and unrelated host metadata when refreshed', () => {
  const saved = bootstrapSettings([
    '--secondary-domain', 'server.home', '--preferred-domain=server.home',
    '--proxy-port', '18080', '--public-port', '80', '--proxy-network', 'host',
    '--proxy-bind-address', '172.24.0.1'
  ], { customMetadata: 'retained' })
  assert.deepEqual(bootstrapSettings([], saved), saved)
  assert.equal(saved.customMetadata, 'retained')
  assert.equal(saved.domain, 'localhost')
  assert.equal(saved.proxyPort, 18080)
  assert.deepEqual(saved.secondaryDomains, ['server.home'])
  assert.throws(() => bootstrapSettings(['--proxy-port', '80garbage']), /proxyPort/)
  assert.throws(() => bootstrapSettings(['--typo', '80']), /unknown option/)
  assert.throws(() => bootstrapSettings(['--proxy-port']), /requires a value/)
})

test('bad machine settings fail validation before they can reach generated configs', () => {
  for (const settings of [
    null, [], { domain: '' }, { domain: 'http://server.home' }, { domain: 'bad\nname' },
    { domain: '*.server.home' }, { secondaryDomains: 'server.home' },
    { preferredDomain: 'unconfigured.home' }, { proxyPort: 0 }, { proxyPort: '80' },
    { publicPort: 65536 }, { publicScheme: 'ftp' }, { proxyNetwork: 'bad' },
    { proxyBindAddress: '0.0.0.0' }, { proxyBindAddress: '172.24.0.1' }
  ]) assert.throws(() => normalizeHostRouting(settings), undefined, JSON.stringify(settings))
  const normalized = normalizeHostRouting({ domain: 'LOCALHOST.', secondaryDomains: ['SERVER.HOME.', 'localhost', 'server.home'] })
  assert.deepEqual(normalized.secondaryDomains, ['server.home'])
})

test('permanent routes accept either domain and keep one canonical filename identity', () => {
  const short = proxyHostnames('fix.app', remote)
  assert.deepEqual(proxyHostnames('fix.app.localhost', remote), short)
  assert.deepEqual(proxyHostnames('fix.app.server.home', remote), short)
  assert.equal(short.hostname, 'fix.app.localhost')
  assert.deepEqual(short.hostnames, ['fix.app.server.home', 'fix.app.localhost'])
  assert.throws(() => proxyHostnames('bad`host', remote), /hostname suffix/)
})

test('remote dependency origins are public but readiness probes use the private listener', async () => {
  const dependencies = [{ name: 'api', healthPath: '/health?ready=1' }]
  assert.deepEqual(dependencyOrigins(dependencies, remote), { api: 'http://api.server.home' })
  let request
  const results = await probeProjectDependencies(dependencies, {
    config: remote,
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 204 } }
  })
  assert.equal(results[0].url, 'http://api.server.home/health?ready=1')
  assert.equal(results[0].ok, true)
  assert.equal(request.url, 'http://172.24.0.1:18080/health?ready=1')
  assert.equal(request.options.headers.Host, 'api.server.home')
  assert.deepEqual(proxyRequest('https://app.server.home/health', {
    ...remote, publicScheme: 'https', publicPort: 443
  }), {
    url: 'http://172.24.0.1:18080/health', headers: { Host: 'app.server.home', 'X-Forwarded-Proto': 'https' }
  })
})

test('host mode is explicitly selected and the static entry point binds the private interface', () => {
  const config = { ...remote, infraDir: '/config/infra', routesDir: '/config/routes', infraProject: 'devkit-infra' }
  assert.deepEqual(proxyCompose(config).files, ['/config/infra/compose.host.yml'])
  assert.deepEqual(proxyCompose({ ...config, proxyNetwork: 'bridge' }).files, ['/config/infra/compose.yml'])
  const template = readFileSync(new URL('../infra/traefik.yml', import.meta.url), 'utf8')
  assert.match(traefikConfig(template, remote), /address: "172\.24\.0\.1:18080"/)
  assert.match(traefikConfig(template, { proxyPort: 8080 }), /address: ":80"/)
})

test('nginx forwards both domains with websocket support and explicit client access', () => {
  const snippet = nginxConfig(remote, ['--allow', '192.168.2.0/24', '--allow', '172.24.0.1'])
  assert.match(snippet, /server_name \*\.localhost \*\.server\.home;/)
  assert.match(snippet, /listen 80;/)
  assert.match(snippet, /proxy_pass http:\/\/172\.24\.0\.1:18080;/)
  assert.match(snippet, /proxy_set_header Host \$http_host;/)
  assert.match(snippet, /proxy_set_header Upgrade \$http_upgrade;/)
  assert.match(snippet, /allow 192\.168\.2\.0\/24;/)
  assert.match(snippet, /deny all;/)
  assert.doesNotMatch(snippet, /server_name server\.home/)
  assert.throws(() => nginxConfig(remote, ['--allow', '192.168.2.0/99']), /invalid allowed/)
  assert.throws(() => nginxConfig(remote, ['--upstream', 'http://upstream/path']), /HTTP origin/)
})

test('nginx HTTPS generation requires certificate paths and preserves the public port', () => {
  const https = { ...remote, publicScheme: 'https', publicPort: 8443 }
  assert.throws(() => nginxConfig(https), /HTTPS requires/)
  const snippet = nginxConfig(https, ['--ssl-certificate', '/certs/dev.crt', '--ssl-certificate-key', '/certs/dev.key'])
  assert.match(snippet, /listen 8443 ssl;/)
  assert.match(snippet, /ssl_certificate "\/certs\/dev\.crt";/)
})
