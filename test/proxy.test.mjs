import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { deriveCheckoutIdentity } from '../src/checkout-identity.mjs'
import { removeRoute, routeFilePath, writeRoute } from '../src/proxy.mjs'

function scratchConfig() {
  return { routesDir: mkdtempSync(path.join(tmpdir(), 'printstream-routes-')) }
}

function worktreeIdentity(name) {
  return deriveCheckoutIdentity({
    gitDir: `/workspace/printstream/.git/worktrees/${name}`,
    gitCommonDir: '/workspace/printstream/.git',
    toplevel: `/workspace/printstream/.worktrees/${name}`,
    root: `/workspace/printstream/.worktrees/${name}`
  })
}

test('the route sends the checkout hostname to its port on the host', () => {
  const config = scratchConfig()
  try {
    const identity = worktreeIdentity('slice-crash-gate')
    const file = writeRoute(config, identity, 31180)
    const contents = readFileSync(file, 'utf8')

    assert.match(contents, /rule: "Host\(`slice-crash-gate\.printstream\.localhost`\)"/)
    assert.match(contents, /url: "http:\/\/host\.docker\.internal:31180"/)
    assert.match(contents, /entryPoints:\n\s+- web/)
  } finally {
    rmSync(config.routesDir, { recursive: true, force: true })
  }
})

test('rewriting a route replaces it rather than appending a second router', () => {
  const config = scratchConfig()
  try {
    const identity = worktreeIdentity('slice-crash-gate')
    writeRoute(config, identity, 31180)
    const contents = readFileSync(writeRoute(config, identity, 24730), 'utf8')

    assert.equal(contents.match(/rule:/g).length, 1)
    assert.match(contents, /24730/)
    assert.doesNotMatch(contents, /31180/)
  } finally {
    rmSync(config.routesDir, { recursive: true, force: true })
  }
})

test('two checkouts write separate files, so one cannot clobber the other', () => {
  const config = scratchConfig()
  try {
    const a = worktreeIdentity('issue-100-em-dashes')
    const b = worktreeIdentity('slice-crash-gate')
    writeRoute(config, a, 21000)
    writeRoute(config, b, 22000)

    assert.notEqual(routeFilePath(config, a), routeFilePath(config, b))
    assert.ok(existsSync(routeFilePath(config, a)))
    assert.ok(existsSync(routeFilePath(config, b)))
  } finally {
    rmSync(config.routesDir, { recursive: true, force: true })
  }
})

test('removing a route is idempotent and never throws on a missing file', () => {
  const config = scratchConfig()
  try {
    const identity = worktreeIdentity('slice-crash-gate')
    writeRoute(config, identity, 31180)
    removeRoute(config, identity)
    assert.equal(existsSync(routeFilePath(config, identity)), false)
    removeRoute(config, identity)
  } finally {
    rmSync(config.routesDir, { recursive: true, force: true })
  }
})
