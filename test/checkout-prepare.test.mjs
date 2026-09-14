import assert from 'node:assert/strict'
import process from 'node:process'
import { test } from 'node:test'

import { prepareCheckout } from '../src/checkout-prepare.mjs'

test('checkout preparation copies local files before ensuring dependencies', async () => {
  const checkout = { toplevel: '/checkout' }
  const project = { install: { command: ['npm', 'ci'] } }
  const calls = []

  const result = await prepareCheckout({
    repoRoot: '/checkout',
    log: null,
    readCheckout: () => checkout,
    loadProject: async () => project,
    copyFiles: (options) => {
      calls.push(['copy', options])
      return { copied: ['.env'], missing: [] }
    },
    ensureInstall: (options) => {
      calls.push(['install', options])
      return { installed: true }
    },
    detectPackageManager: () => 'npm/test'
  })

  assert.deepEqual(calls, [
    ['copy', { checkout, project }],
    ['install', {
      repoRoot: '/checkout',
      project,
      packageManagerIdentity: process.env.npm_config_user_agent ?? 'npm/test'
    }]
  ])
  assert.deepEqual(result, {
    checkout,
    project,
    inherited: { copied: ['.env'], missing: [] },
    installation: { installed: true }
  })
})

test('checkout preparation is unavailable outside a Git checkout', async () => {
  const result = await prepareCheckout({
    repoRoot: '/not-a-checkout',
    readCheckout: () => null,
    loadProject: () => assert.fail('project config must not load outside Git')
  })

  assert.equal(result, null)
})
