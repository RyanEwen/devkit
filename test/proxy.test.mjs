import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { deriveCheckoutIdentity } from '../src/checkout-identity.mjs'
import {
  acquireProxy,
  reconcileProxy,
  releaseProxy,
  removeRoute,
  routeFilePath,
  writeRoute
} from '../src/proxy.mjs'

function scratchConfig() {
  const configDir = mkdtempSync(path.join(tmpdir(), 'devkit-proxy-'))
  return {
    configDir,
    routesDir: path.join(configDir, 'routes'),
    infraDir: path.join(configDir, 'infra'),
    infraProject: 'devkit-infra',
    proxyPort: 80
  }
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
    rmSync(config.configDir, { recursive: true, force: true })
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
    rmSync(config.configDir, { recursive: true, force: true })
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
    rmSync(config.configDir, { recursive: true, force: true })
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
    rmSync(config.configDir, { recursive: true, force: true })
  }
})

test('the proxy starts on acquisition and stops only after its final route is released', () => {
  const config = scratchConfig()
  const starts = []
  const stops = []
  const first = worktreeIdentity('first')
  const second = worktreeIdentity('second')
  const start = (...args) => {
    starts.push(args)
    return true
  }
  const stop = (...args) => {
    stops.push(args)
    return true
  }

  try {
    assert.equal(acquireProxy(config, first, 21000, { start }), true)
    assert.equal(acquireProxy(config, second, 22000, { start }), true)
    assert.equal(starts.length, 2)

    assert.equal(releaseProxy(config, first, { stop }), true)
    assert.equal(stops.length, 0)
    assert.equal(releaseProxy(config, second, { stop }), true)
    assert.equal(stops.length, 1)
  } finally {
    rmSync(config.configDir, { recursive: true, force: true })
  }
})

test('bootstrap reconciliation removes a legacy proxy unless routes are active', () => {
  const config = scratchConfig()
  const starts = []
  const stops = []
  const start = (...args) => {
    starts.push(args)
    return true
  }
  const stop = (...args) => {
    stops.push(args)
    return true
  }

  try {
    assert.deepEqual(reconcileProxy(config, { start, stop }), { ok: true, running: false })
    assert.equal(starts.length, 0)
    assert.equal(stops.length, 1)

    writeRoute(config, worktreeIdentity('active'), 21000)
    assert.deepEqual(reconcileProxy(config, { start, stop }), { ok: true, running: true })
    assert.equal(starts.length, 1)
    assert.equal(stops.length, 1)
  } finally {
    rmSync(config.configDir, { recursive: true, force: true })
  }
})

test('reconciliation removes abandoned leased and legacy checkout routes', () => {
  const config = scratchConfig()
  const leased = worktreeIdentity('leased')
  const legacy = worktreeIdentity('legacy')
  const stops = []

  try {
    const leasedFile = writeRoute(config, leased, 21000)
    writeFileSync(
      leasedFile,
      readFileSync(leasedFile, 'utf8').replace(String(process.pid), '2147483647'),
      'utf8'
    )
    const legacyFile = writeRoute(config, legacy, 22000)
    writeFileSync(
      legacyFile,
      readFileSync(legacyFile, 'utf8').replace(/^# Devkit checkout owner pid: \d+\n/m, ''),
      'utf8'
    )

    const result = reconcileProxy(config, {
      containers: () => [],
      start: () => true,
      stop: (...args) => {
        stops.push(args)
        return true
      }
    })

    assert.deepEqual(result, { ok: true, running: false })
    assert.equal(existsSync(leasedFile), false)
    assert.equal(existsSync(legacyFile), false)
    assert.equal(stops.length, 1)
  } finally {
    rmSync(config.configDir, { recursive: true, force: true })
  }
})

test('reconciliation preserves a legacy route whose checkout stack is still running', () => {
  const config = scratchConfig()
  const identity = worktreeIdentity('legacy-active')

  try {
    const file = writeRoute(config, identity, 22000)
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^# Devkit checkout owner pid: \d+\n/m, ''), 'utf8')
    const result = reconcileProxy(config, {
      containers: (project) => project === identity.composeProject ? ['database'] : [],
      start: () => true,
      stop: () => true
    })

    assert.deepEqual(result, { ok: true, running: true })
    assert.equal(existsSync(file), true)
  } finally {
    rmSync(config.configDir, { recursive: true, force: true })
  }
})
