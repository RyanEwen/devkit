import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  browserCommand,
  checkoutBrowserUrls,
  isVsCodeTerminal,
  scheduleBrowserOpen,
  vsCodeBrowserHelper
} from '../src/browser.mjs'

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

test('VS Code terminals are detected from local and remote environment markers', () => {
  assert.equal(isVsCodeTerminal({ TERM_PROGRAM: 'vscode' }), true)
  assert.equal(isVsCodeTerminal({ VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc.sock' }), true)
  assert.equal(isVsCodeTerminal({ TERM_PROGRAM: 'other' }), false)
})

test('VS Code Server browser helper is resolved from terminal environment', () => {
  const env = {
    VSCODE_IPC_HOOK_CLI: '/run/user/1000/vscode-ipc.sock',
    VSCODE_NLS_CONFIG: JSON.stringify({
      defaultMessagesFile: '/home/me/.vscode-server/bin/commit/out/nls.messages.json'
    })
  }
  assert.equal(
    vsCodeBrowserHelper(env, { existsSyncImpl: () => true }),
    '/home/me/.vscode-server/bin/commit/bin/helpers/browser.sh'
  )
  assert.deepEqual(browserCommand('http://app.localhost/', {
    env: { ...env, WSL_DISTRO_NAME: 'Ubuntu' },
    existsSyncImpl: () => true
  }), {
    command: '/home/me/.vscode-server/bin/commit/bin/helpers/browser.sh',
    args: ['http://app.localhost/']
  })
})

test('DEVKIT_OPEN_BROWSER=0 suppresses the detached opener', () => {
  let spawned = false
  assert.equal(scheduleBrowserOpen('http://app.localhost/', 'http://app.localhost/', {
    env: { DEVKIT_OPEN_BROWSER: '0' },
    spawnImpl: () => { spawned = true }
  }), false)
  assert.equal(spawned, false)
})

test('VS Code browser waiter inherits output so its ready URL is clickable', () => {
  let options
  let unreferenced = false
  assert.equal(scheduleBrowserOpen('http://app.localhost/', 'http://app.localhost/', {
    env: { TERM_PROGRAM: 'vscode' },
    spawnImpl: (_command, _args, spawnOptions) => {
      options = spawnOptions
      return { unref: () => { unreferenced = true } }
    }
  }), true)
  assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit'])
  assert.equal(unreferenced, true)
})
