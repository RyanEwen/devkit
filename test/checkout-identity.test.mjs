import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  baselineDatabaseName,
  checkoutPorts,
  deriveCheckoutIdentity,
  postgresIdentifier,
  sanitizeLabel
} from '../src/checkout-identity.mjs'

/** Shapes the exact strings `git rev-parse --git-dir --git-common-dir --show-toplevel` prints. */
function primaryCheckout(root = '/workspace/printstream') {
  return { gitDir: '.git', gitCommonDir: '.git', toplevel: root, root }
}

function worktreeCheckout(name, main = '/workspace/printstream') {
  const root = `${main}/.worktrees/${name}`
  return { gitDir: `${main}/.git/worktrees/${name}`, gitCommonDir: `${main}/.git`, toplevel: root, root }
}

test('primary checkout keeps the bare repo name so it adopts the existing dev database', () => {
  const identity = deriveCheckoutIdentity(primaryCheckout())
  assert.equal(identity.isPrimary, true)
  assert.equal(identity.repoName, 'printstream')
  assert.equal(identity.worktreeName, null)
  assert.equal(identity.databaseName, 'printstream')
  assert.equal(identity.hostname, 'printstream.localhost')
})

test('a worktree nests under the repo hostname and namespaces its database', () => {
  const identity = deriveCheckoutIdentity(worktreeCheckout('slice-crash-gate'))
  assert.equal(identity.isPrimary, false)
  assert.equal(identity.repoName, 'printstream')
  assert.equal(identity.worktreeName, 'slice-crash-gate')
  assert.equal(identity.hostname, 'slice-crash-gate.printstream.localhost')
  assert.equal(identity.databaseName, 'printstream_wt_slice_crash_gate')
  assert.equal(identity.composeProject, 'printstream-wt-slice-crash-gate')
})

test('identity comes from the git dir, not the leaf directory', () => {
  // Two worktrees can sit in identically-named leaf directories under different parents; git's
  // worktree name is what actually distinguishes them.
  const a = deriveCheckoutIdentity({
    gitDir: '/workspace/printstream/.git/worktrees/issue-1',
    gitCommonDir: '/workspace/printstream/.git',
    toplevel: '/somewhere/else/build',
    root: '/somewhere/else/build'
  })
  assert.equal(a.worktreeName, 'issue-1')
  assert.equal(a.hostname, 'issue-1.printstream.localhost')
})

test('primary detection survives an absolute git dir', () => {
  const identity = deriveCheckoutIdentity({
    gitDir: '/workspace/printstream/.git',
    gitCommonDir: '/workspace/printstream/.git',
    toplevel: '/workspace/printstream',
    root: '/workspace/printstream'
  })
  assert.equal(identity.isPrimary, true)
  assert.equal(identity.databaseName, 'printstream')
})

test('every real worktree in this repo produces a distinct database and hostname', () => {
  const names = [
    'issue-100-em-dashes',
    'issue-102-pause-markers',
    'issue-96-plates-presets-project',
    'issue-98-notification-sync',
    'slice-crash-gate'
  ]
  const identities = names.map((name) => deriveCheckoutIdentity(worktreeCheckout(name)))
  identities.push(deriveCheckoutIdentity(primaryCheckout()))

  assert.equal(new Set(identities.map((i) => i.databaseName)).size, identities.length)
  assert.equal(new Set(identities.map((i) => i.hostname)).size, identities.length)
  for (const identity of identities) {
    assert.ok(identity.databaseName.length <= 63, `${identity.databaseName} exceeds the Postgres limit`)
  }
})

test('over-long names stay distinct instead of colliding on a shared prefix', () => {
  const shared = 'worktree-with-an-extremely-long-descriptive-branch-name-that-keeps-going'
  const a = postgresIdentifier('printstream_wt_', `${shared}-alpha`)
  const b = postgresIdentifier('printstream_wt_', `${shared}-beta`)

  assert.ok(a.length <= 63)
  assert.ok(b.length <= 63)
  assert.notEqual(a, b, 'truncation alone would have merged two worktrees into one database')
})

test('postgresIdentifier is stable for the same input', () => {
  const name = 'a'.repeat(90)
  assert.equal(postgresIdentifier('printstream_wt_', name), postgresIdentifier('printstream_wt_', name))
})

test('sanitizeLabel produces valid DNS labels', () => {
  assert.equal(sanitizeLabel('.cache'), 'cache')
  assert.equal(sanitizeLabel('Issue_96/Plates'), 'issue-96-plates')
  assert.equal(sanitizeLabel('--trim--'), 'trim')
  assert.equal(sanitizeLabel(''), '')
  assert.ok(!sanitizeLabel('x'.repeat(80) + '---').endsWith('-'))
  assert.ok(sanitizeLabel('x'.repeat(80)).length <= 63)
})

test('unnameable segments fall back rather than producing an empty hostname', () => {
  const identity = deriveCheckoutIdentity({
    gitDir: '/srv/___/.git/worktrees/___',
    gitCommonDir: '/srv/___/.git',
    toplevel: '/srv/___/wt',
    root: '/srv/___/wt'
  })
  assert.equal(identity.repoName, 'repo')
  assert.equal(identity.worktreeName, 'worktree')
  assert.equal(identity.hostname, 'worktree.repo.localhost')
})

test('ports are stable, in range, and distinct per checkout', () => {
  delete process.env.DEVKIT_PORT_BASE
  const primary = checkoutPorts(deriveCheckoutIdentity(primaryCheckout()))
  const worktree = checkoutPorts(deriveCheckoutIdentity(worktreeCheckout('slice-crash-gate')))

  assert.deepEqual(primary, checkoutPorts(deriveCheckoutIdentity(primaryCheckout())), 'not stable')
  assert.notEqual(primary.web, worktree.web)
  for (const ports of [primary, worktree]) {
    assert.ok(ports.base >= 20000 && ports.base < 25000, `${ports.base} outside the block range`)
    assert.equal(ports.base % 10, 0, 'blocks must start on a multiple of ten')
  }

  // Named ports are offsets within the block, so a four-port project gets four distinct ones.
  const named = checkoutPorts(deriveCheckoutIdentity(primaryCheckout()), ['web', 'api', 'metrics', 'slicer'])
  assert.equal(new Set([named.web, named.api, named.metrics, named.slicer]).size, 4)
  assert.equal(named.web, named.base)
})

test('an explicit port base overrides the derivation for one checkout', () => {
  process.env.DEVKIT_PORT_BASE = '31000'
  try {
    assert.equal(checkoutPorts(deriveCheckoutIdentity(primaryCheckout())).api, 31001)
  } finally {
    delete process.env.DEVKIT_PORT_BASE
  }
})

test('the baseline is one per clone, shared by every worktree of it', () => {
  const fromPrimary = baselineDatabaseName(deriveCheckoutIdentity(primaryCheckout()))
  const fromWorktree = baselineDatabaseName(deriveCheckoutIdentity(worktreeCheckout('slice-crash-gate')))
  assert.equal(fromPrimary, 'printstream_baseline')
  assert.equal(fromPrimary, fromWorktree)
})
