import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  browserCommand,
  checkoutBrowserUrls,
  ensureVsCodeBrowserBridge,
  integratedBrowserCommand,
  isVsCodeTerminal,
  openBrowser,
  scheduleBrowserOpen,
  vsCodeBrowserHelper,
  vsCodeBrowserUri
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
  assert.equal(isVsCodeTerminal({ VSCODE_NLS_CONFIG: '{"defaultMessagesFile":"/tmp/messages.json"}' }), true)
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

test('VS Code Server browser helper survives agent processes without the IPC hook', () => {
  const env = {
    VSCODE_NLS_CONFIG: JSON.stringify({
      defaultMessagesFile: '/home/me/.vscode-server/bin/commit/out/nls.messages.json'
    })
  }
  assert.equal(
    vsCodeBrowserHelper(env, { existsSyncImpl: () => true }),
    '/home/me/.vscode-server/bin/commit/bin/helpers/browser.sh'
  )
})

test('VS Code Server browser helper uses the askpass runtime available in integrated terminals', () => {
  const env = {
    VSCODE_IPC_HOOK_CLI: '/run/user/1000/vscode-ipc.sock',
    VSCODE_GIT_ASKPASS_NODE: '/home/me/.vscode-server/bin/commit/node'
  }
  assert.equal(
    vsCodeBrowserHelper(env, { existsSyncImpl: () => true }),
    '/home/me/.vscode-server/bin/commit/bin/helpers/browser.sh'
  )
})

test('VS Code browser URI safely carries the complete project URL', () => {
  assert.equal(
    vsCodeBrowserUri('http://public-api.localhost/api/?one=two'),
    'vscode://ryanewen.devkit-browser/open?url=http%3A%2F%2Fpublic-api.localhost%2Fapi%2F%3Fone%3Dtwo'
  )
})

test('installed VS Code browser bridge is reused', () => {
  const calls = []
  assert.equal(ensureVsCodeBrowserBridge({
    spawnSyncImpl: (command, args) => {
      calls.push([command, args])
      return { status: 0, stdout: 'ryanewen.devkit-browser@0.1.0\n' }
    }
  }), true)
  assert.equal(calls.length, 1)
})

test('missing VS Code browser bridge is installed from the bundled VSIX', () => {
  const calls = []
  assert.equal(ensureVsCodeBrowserBridge({
    spawnSyncImpl: (command, args) => {
      calls.push([command, args])
      return { status: 0, stdout: '' }
    }
  }), true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1][1][0], '--install-extension')
  assert.match(calls[1][1][1], /devkit-browser-0\.1\.0\.vsix$/)
})

test('integrated browser command sends the URL through VS Code Server', () => {
  const env = {
    VSCODE_IPC_HOOK_CLI: '/run/user/1000/vscode-ipc.sock',
    BROWSER: '/opt/vscode/browser.sh'
  }
  assert.deepEqual(integratedBrowserCommand('http://app.localhost/', {
    env,
    existsSyncImpl: () => true,
    spawnSyncImpl: () => ({ status: 0, stdout: 'ryanewen.devkit-browser@0.1.0\n' })
  }), {
    command: '/opt/vscode/browser.sh',
    args: ['vscode://ryanewen.devkit-browser/open?url=http%3A%2F%2Fapp.localhost%2F']
  })
})

test('failed bridge setup falls back to the native browser', () => {
  let opened
  assert.equal(openBrowser('http://app.localhost/', {
    env: { TERM_PROGRAM: 'vscode', WSL_DISTRO_NAME: 'Ubuntu' },
    existsSyncImpl: () => false,
    log: () => {},
    spawnImpl: (command, args) => {
      opened = [command, args]
      return { unref: () => {} }
    }
  }), 'native')
  assert.deepEqual(opened, ['cmd.exe', ['/c', 'start', '', 'http://app.localhost/']])
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
