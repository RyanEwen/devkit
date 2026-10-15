import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { configuredDomains, isAllowedProjectUrl } = require('../vscode-extension/url.cjs')

test('browser bridge accepts only local HTTP project URLs', () => {
  assert.equal(isAllowedProjectUrl('http://app.localhost/'), true)
  assert.equal(isAllowedProjectUrl('https://localhost:3000/'), true)
  assert.equal(isAllowedProjectUrl('https://example.com/'), false)
  assert.equal(isAllowedProjectUrl('file:///etc/passwd'), false)
  assert.equal(isAllowedProjectUrl('not a URL'), false)
})

test('tagged Devkit installs include the packaged browser bridge', () => {
  assert.equal(existsSync(new URL('../vscode-extension/devkit-browser-0.3.0.vsix', import.meta.url)), true)
})

test('browser bridge accepts only explicitly configured remote project domains', () => {
  const domains = ['localhost', 'server.home']
  assert.equal(isAllowedProjectUrl('http://app.server.home/', domains), true)
  assert.equal(isAllowedProjectUrl('https://fix.app.server.home/', domains), true)
  assert.equal(isAllowedProjectUrl('http://app.unconfigured.home/', domains), false)
  assert.equal(isAllowedProjectUrl('http://app.server.home.evil.test/', domains), false)
  assert.equal(isAllowedProjectUrl('http://appserver.home/', domains), false)
  assert.equal(isAllowedProjectUrl('http://user:pass@app.server.home/', domains), false)
  assert.equal(isAllowedProjectUrl('http://[::1]/'), true)
})

test('browser bridge reads domains from the host marker and tolerates missing or malformed settings', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'devkit-bridge-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env = { DEVKIT_CONFIG_DIR: directory }
  assert.deepEqual(configuredDomains(env), [])
  writeFileSync(path.join(directory, 'host.json'), JSON.stringify({ enabled: true, secondaryDomains: ['SERVER.HOME.'] }))
  assert.deepEqual(configuredDomains(env), ['localhost', 'server.home'])
  writeFileSync(path.join(directory, 'host.json'), '{broken')
  assert.deepEqual(configuredDomains(env), [])
  writeFileSync(path.join(directory, 'host.json'), JSON.stringify({ enabled: false, secondaryDomains: ['server.home'] }))
  assert.deepEqual(configuredDomains(env), [])
})
