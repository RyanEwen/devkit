import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { cleanupCheckout, checkoutWorkspaceReferences } from '../src/checkout-cleanup.mjs'

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-cleanup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const identity = { isPrimary: false, toplevel: root, composeProject: 'demo-wt-feature', slug: 'demo-feature' }
  const events = []
  const owned = ['demo-wt-feature-database', 'demo-wt-feature_slicer-data']
  const volumes = [...owned, 'shared-engine-cache', 'demo-database', 'demo-wt-other-database']
  const run = (command, args) => {
    assert.equal(command, 'docker')
    events.push(args)
    if (args[0] === 'ps') return 'container-private'
    if (args[0] === 'network' && args[1] === 'ls') return 'network-private'
    if (args[0] === 'volume' && args[1] === 'ls') return volumes.join('\n')
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return JSON.stringify([{ Labels: { 'com.docker.compose.project': identity.composeProject } }])
    }
    return ''
  }
  return {
    events, owned, identity,
    options: {
      repoRoot: root, identity, config: {}, yes: true,
      load: async () => ({ cleanup: { volumes: ['{project}_slicer-data'] } }),
      run, log: () => {},
      stopRunner: async () => events.push(['stop-runner']),
      acquireRunner: () => { events.push(['lease']); return { release: () => events.push(['release']) } },
      releaseRoute: () => { events.push(['route']); return true },
      ...options
    }
  }
}

test('cleanup removes only declared worktree volumes, holds the lease, and needs no Compose configuration', async (t) => {
  const { options, events, owned } = fixture(t)
  await cleanupCheckout(options)
  assert.deepEqual(events.filter((args) => args[0] === 'volume' && args[1] === 'rm').map((args) => args[2]), owned)
  assert.ok(events.findIndex((e) => e[0] === 'stop-runner') < events.findIndex((e) => e[0] === 'stop'))
  assert.deepEqual(events.at(-1), ['release'])
  assert.ok(events.some((e) => e[0] === 'route'))
  assert.ok(!events.some((e) => e.includes('compose') || e.includes('--force')))
})

test('a preview does not stop runners or mutate resources', async (t) => {
  const { options, events } = fixture(t, { yes: false })
  await cleanupCheckout(options)
  assert.ok(events.every((e) => ['ps', 'network', 'volume'].includes(e[0])))
  assert.ok(!events.some((e) => e.includes('rm')))
})

test('primary checkouts are rejected before reading config or Docker', async (t) => {
  const f = fixture(t)
  await assert.rejects(cleanupCheckout({ ...f.options, identity: { ...f.identity, isPrimary: true } }), /refuses primary/)
  assert.deepEqual(f.events, [])
})

test('an active Paseo reference preserves running resources, including background/nested paths', async (t) => {
  const f = fixture(t)
  const nested = path.join(f.identity.toplevel, 'app'); mkdirSync(nested)
  const result = await cleanupCheckout({ ...f.options, paseo: true,
    env: { PASEO_WORKTREE_PATH: f.identity.toplevel },
    listWorkspaces: () => [{ cwd: nested, background: true }]
  })
  assert.equal(result.preserved, true)
  assert.deepEqual(f.events, [])
})

test('Paseo lookup failure or malformed response fails closed before stopping anything', async (t) => {
  const f = fixture(t)
  for (const listWorkspaces of [() => { throw new Error('daemon unavailable') }, () => ({}), () => [{}]]) {
    await assert.rejects(cleanupCheckout({ ...f.options, paseo: true,
      env: { PASEO_WORKTREE_PATH: f.identity.toplevel }, listWorkspaces }))
  }
  assert.deepEqual(f.events, [])
})

test('archive invocation must attest the exact worktree path', async (t) => {
  const f = fixture(t)
  await assert.rejects(cleanupCheckout({ ...f.options, paseo: true, env: {} }), /matching PASEO_WORKTREE_PATH/)
  assert.deepEqual(f.events, [])
})

test('a workspace opened while waiting for a runner preserves its data', async (t) => {
  const f = fixture(t); let checks = 0
  const result = await cleanupCheckout({ ...f.options, paseo: true,
    env: { PASEO_WORKTREE_PATH: f.identity.toplevel },
    listWorkspaces: () => ++checks === 1 ? [] : [{ cwd: f.identity.toplevel }]
  })
  assert.equal(result.preserved, true)
  assert.ok(!f.events.some((e) => e[0] === 'stop' || e.includes('rm')))
  assert.deepEqual(f.events.at(-1), ['release'])
})

test('foreign volume ownership is rejected before any mutation', async (t) => {
  const f = fixture(t)
  await assert.rejects(cleanupCheckout({ ...f.options, run: (command, args) => {
    if (args[0] === 'volume' && args[1] === 'inspect') return JSON.stringify([{ Labels: {} }])
    return f.options.run(command, args)
  } }), /ownership does not match/)
  assert.ok(!f.events.some((e) => e[0] === 'stop-runner'))
})

test('a failed container shutdown prevents data deletion and releases the lease', async (t) => {
  const f = fixture(t)
  await assert.rejects(cleanupCheckout({ ...f.options, run: (command, args) => {
    if (args[0] === 'stop') throw new Error('stop failed')
    return f.options.run(command, args)
  } }), /stop failed/)
  assert.ok(!f.events.some((e) => e.includes('rm')))
  assert.deepEqual(f.events.at(-1), ['release'])
})

test('an already removed database is idempotent', async (t) => {
  const f = fixture(t)
  const result = await cleanupCheckout({ ...f.options, run: (command, args) => {
    if (args[0] === 'volume' && args[1] === 'ls') return ''
    return f.options.run(command, args)
  } })
  assert.deepEqual(result.volumes, [])
})

test('workspace references resolve symlinks without matching sibling prefixes', (t) => {
  const f = fixture(t)
  const link = `${f.identity.toplevel}-link`; symlinkSync(f.identity.toplevel, link)
  t.after(() => rmSync(link))
  assert.equal(checkoutWorkspaceReferences([{ cwd: link }, { cwd: `${link}-other` }], f.identity.toplevel).length, 1)
})
