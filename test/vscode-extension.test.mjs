import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { isAllowedProjectUrl } = require('../vscode-extension/url.cjs')

test('browser bridge accepts only local HTTP project URLs', () => {
  assert.equal(isAllowedProjectUrl('http://app.localhost/'), true)
  assert.equal(isAllowedProjectUrl('https://localhost:3000/'), true)
  assert.equal(isAllowedProjectUrl('https://example.com/'), false)
  assert.equal(isAllowedProjectUrl('file:///etc/passwd'), false)
  assert.equal(isAllowedProjectUrl('not a URL'), false)
})

test('tagged Devkit installs include the packaged browser bridge', () => {
  assert.equal(existsSync(new URL('../vscode-extension/devkit-browser-0.1.0.vsix', import.meta.url)), true)
})
