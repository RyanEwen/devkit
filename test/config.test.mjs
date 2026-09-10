import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { checkoutConnectionUrl, checkoutDatabase, devkitConfig } from '../src/config.mjs'

/**
 * These pin the OFF switches rather than the settings, because the promise that matters is the one
 * made to people who never opted in: `scripts/dev/` ships in the public snapshot, so a regression
 * here would break `npm run dev` for contributors who have none of this infrastructure.
 */
function withConfigHome(run, { marker } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'printstream-hostmode-'))
  const previousHome = process.env.XDG_CONFIG_HOME
  const previousFlag = process.env.DEVKIT
  process.env.XDG_CONFIG_HOME = dir
  delete process.env.DEVKIT
  try {
    if (marker !== undefined) {
      mkdirSync(path.join(dir, 'devkit'), { recursive: true })
      writeFileSync(path.join(dir, 'devkit', 'host.json'), marker, 'utf8')
    }
    return run(dir)
  } finally {
    if (previousHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousHome
    if (previousFlag === undefined) delete process.env.DEVKIT
    else process.env.DEVKIT = previousFlag
    rmSync(dir, { recursive: true, force: true })
  }
}

const notInContainer = () => false

test('off when there is no marker, which is every fresh clone and all of CI', () => {
  withConfigHome(() => {
    assert.equal(devkitConfig({ containerCheck: notInContainer }), null)
  })
})

test('off inside a container even when a marker is present, so the devcontainer always wins', () => {
  withConfigHome(
    () => {
      assert.equal(devkitConfig({ containerCheck: () => true }), null)
    },
    { marker: JSON.stringify({ enabled: true }) }
  )
})

test('off when the kill switch is set, whatever else is true', () => {
  withConfigHome(
    () => {
      process.env.DEVKIT = '0'
      assert.equal(devkitConfig({ containerCheck: notInContainer }), null)
    },
    { marker: JSON.stringify({ enabled: true }) }
  )
})

test('off when the marker disables itself, without deleting the file', () => {
  withConfigHome(
    () => {
      assert.equal(devkitConfig({ containerCheck: notInContainer }), null)
    },
    { marker: JSON.stringify({ enabled: false }) }
  )
})

test('a malformed marker warns and stays off rather than throwing into the dev runner', () => {
  withConfigHome(
    () => {
      const warnings = []
      assert.equal(devkitConfig({ containerCheck: notInContainer, warn: (m) => warnings.push(m) }), null)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /host\.json/)
    },
    { marker: '{ not json' }
  )
})

test('on with a marker present, defaulting every path under the config directory', () => {
  withConfigHome(
    (dir) => {
      const config = devkitConfig({ containerCheck: notInContainer })
      assert.ok(config)
      assert.equal(config.infraProject, 'devkit-infra')
      assert.equal(config.proxyPort, 80)
      assert.equal(config.postgres.port, 5432)
      assert.deepEqual(config.mariadb, {
        host: '127.0.0.1',
        port: 3307,
        user: 'root',
        password: 'root',
        volume: 'devkit-mariadb'
      })
      assert.equal(config.routesDir, path.join(dir, 'devkit', 'routes'))
      assert.equal(config.infraDir, path.join(dir, 'devkit', 'infra'))
    },
    { marker: JSON.stringify({ enabled: true }) }
  )
})

test('marker values override the defaults', () => {
  withConfigHome(
    () => {
      const config = devkitConfig({ containerCheck: notInContainer })
      assert.equal(config.proxyPort, 8080)
      assert.equal(config.postgres.port, 5555)
      assert.equal(config.mariadb.port, 3337)
      assert.equal(config.baselineMaxAgeDays, 3)
    },
    {
      marker: JSON.stringify({
        enabled: true,
        proxyPort: 8080,
        postgres: { port: 5555 },
        mariadb: { port: 3337 },
        baselineMaxAgeDays: 3
      })
    }
  )
})

test('connection URLs use the selected backend and encode credentials', () => {
  const config = {
    postgres: { host: '127.0.0.1', port: 5432, user: 'post user', password: 'p@ss' },
    mariadb: { host: '127.0.0.1', port: 3307, user: 'root', password: 'm@ria' }
  }
  assert.equal(
    checkoutConnectionUrl(config, 'printstream'),
    'postgresql://post%20user:p%40ss@127.0.0.1:5432/printstream?schema=public'
  )
  assert.equal(
    checkoutConnectionUrl(config, 'wyliebiz_app', 'mariadb'),
    'mysql://root:m%40ria@127.0.0.1:3307/wyliebiz_app'
  )
  assert.deepEqual(checkoutDatabase(config, 'wyliebiz_app', 'mariadb'), {
    engine: 'mariadb',
    name: 'wyliebiz_app',
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'm@ria',
    url: 'mysql://root:m%40ria@127.0.0.1:3307/wyliebiz_app'
  })
})
