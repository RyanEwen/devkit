import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  dependencyOrigins,
  dependencyUrl,
  failedProjectDependencies,
  probeProjectDependencies
} from '../src/project-dependencies.mjs'

test('dependency URLs use the shared Traefik port and configured health path', () => {
  const dependency = { name: 'public-api', healthPath: '/api/_health' }
  assert.equal(dependencyUrl(dependency), 'http://public-api.localhost/api/_health')
  assert.equal(dependencyUrl(dependency, 8080), 'http://public-api.localhost:8080/api/_health')
  assert.deepEqual(dependencyOrigins([dependency], 8080), {
    'public-api': 'http://public-api.localhost:8080'
  })
})

test('a worktree target selects that worktree of the dependency for URLs and origins', () => {
  const dependency = { name: 'platform', healthPath: '/integrations/health/live' }
  assert.equal(dependencyUrl(dependency, {}, 'pickup-limits'), 'http://pickup-limits.platform.localhost/integrations/health/live')
  assert.deepEqual(
    dependencyOrigins([dependency, { name: 'public-api' }], 8080, { platform: 'pickup-limits' }),
    { platform: 'http://pickup-limits.platform.localhost:8080', 'public-api': 'http://public-api.localhost:8080' }
  )
})

test('probes check the targeted worktree and report which one they checked', async () => {
  const requested = []
  const results = await probeProjectDependencies(
    [{ name: 'platform', healthPath: '/health' }, { name: 'public-api', healthPath: '/health' }],
    { targets: { platform: 'pickup-limits' }, fetchImpl: async (url) => { requested.push(url); return { ok: true, status: 200 } } }
  )
  assert.deepEqual(requested, ['http://pickup-limits.platform.localhost/health', 'http://public-api.localhost/health'])
  assert.deepEqual(results.map(({ worktree }) => worktree), ['pickup-limits', undefined])
})

test('dependency names that match object built-ins resolve normally', () => {
  assert.deepEqual(dependencyOrigins([{ name: 'constructor' }], {}, {}), { constructor: 'http://constructor.localhost' })
})

test('a successful dependency does not fail preflight', async () => {
  const requested = []
  const failures = await failedProjectDependencies(
    [{ name: 'public-api', healthPath: '/api/_health' }],
    { fetchImpl: async (url) => { requested.push(url); return { ok: true, status: 204 } } }
  )
  assert.deepEqual(requested, ['http://public-api.localhost/api/_health'])
  assert.deepEqual(failures, [])
})

test('dependency probes retain successful status for doctor output', async () => {
  const results = await probeProjectDependencies(
    [{ name: 'public-api', healthPath: '/api/_health' }],
    { fetchImpl: async () => ({ ok: true, status: 204 }) }
  )
  assert.deepEqual(results.map(({ ok, detail }) => ({ ok, detail })), [{ ok: true, detail: 'HTTP 204' }])
})

test('unhealthy and unreachable dependencies are both reported', async () => {
  const dependencies = [
    { name: 'public-api', healthPath: '/api/_health' },
    { name: 'business-system', healthPath: '/wylie/' }
  ]
  const failures = await failedProjectDependencies(dependencies, {
    fetchImpl: async (url) => {
      if (url.includes('public-api')) return { ok: false, status: 503 }
      throw new Error('connection refused')
    }
  })
  assert.deepEqual(failures.map(({ dependency, detail }) => [dependency.name, detail]), [
    ['public-api', 'HTTP 503'],
    ['business-system', 'connection refused']
  ])
})
