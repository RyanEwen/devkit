import assert from 'node:assert/strict'
import { test } from 'node:test'

import { browserCommand, checkoutBrowserUrls, scheduleBrowserOpen } from '../src/browser.mjs'

test('browser URLs preserve the proxy port and allow a separate health path', () => {
  assert.deepEqual(
    checkoutBrowserUrls('http://public-api.localhost:8080', {
      path: '/api/',
      healthPath: '/api/_health'
    }),
    {
      openUrl: 'http://public-api.localhost:8080/api/',
      healthUrl: 'http://public-api.localhost:8080/api/_health'
    }
  )
})

test('browser commands use the native host opener', () => {
  assert.deepEqual(browserCommand('http://app.localhost', { platform: 'darwin', env: {} }), {
    command: 'open', args: ['http://app.localhost']
  })
  assert.deepEqual(browserCommand('http://app.localhost', { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), {
    command: 'cmd.exe', args: ['/c', 'start', '', 'http://app.localhost']
  })
  assert.deepEqual(browserCommand('http://app.localhost', { platform: 'linux', env: {} }), {
    command: 'xdg-open', args: ['http://app.localhost']
  })
})

test('DEVKIT_OPEN_BROWSER=0 suppresses the detached opener', () => {
  const previous = process.env.DEVKIT_OPEN_BROWSER
  process.env.DEVKIT_OPEN_BROWSER = '0'
  let spawned = false
  try {
    assert.equal(scheduleBrowserOpen('http://app.localhost/', 'http://app.localhost/', {
      spawnImpl: () => { spawned = true }
    }), false)
    assert.equal(spawned, false)
  } finally {
    if (previous === undefined) delete process.env.DEVKIT_OPEN_BROWSER
    else process.env.DEVKIT_OPEN_BROWSER = previous
  }
})
