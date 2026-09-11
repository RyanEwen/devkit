import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { databaseCompose, infraComposeEnv } from '../src/docker.mjs'

test('infra compose receives only proxy settings', () => {
  const env = infraComposeEnv({
    routesDir: '/config/routes',
    baselineDir: '/config/baselines',
    proxyPort: 80,
    postgres: { port: 5432, user: 'postgres', password: 'postgres' },
    mariadb: { port: 3307, user: 'root', password: 'root', volume: 'custom-maria' }
  })

  assert.deepEqual(env, { DEVKIT_ROUTES_DIR: '/config/routes', DEVKIT_PROXY_PORT: '80' })
})

test('a checkout database gets an exact image and only its engine credentials', () => {
  const runtime = databaseCompose({
    infraProject: 'devkit-infra',
    infraDir: '/config/infra',
    baselineDir: '/config/baselines',
    mariadb: { port: 3340, user: 'root', password: 'secret' },
    databaseRuntime: {
      engine: 'mariadb', version: '10.2',
      project: 'app-wt-issue', service: 'database',
      composeFile: '/config/infra/mariadb.yml', volume: 'app-wt-issue-database'
    }
  })
  assert.equal(runtime.project, 'app-wt-issue')
  assert.equal(runtime.env.DEVKIT_DATABASE_IMAGE, 'mariadb:10.2')
  assert.equal(runtime.env.DEVKIT_DATABASE_PORT, undefined)
  assert.equal(runtime.env.DEVKIT_DATABASE_PASSWORD, 'secret')
  assert.equal(runtime.env.DEVKIT_POSTGRES_PASSWORD, undefined)
})

test('a checkout database has no published port and uses the checkout-owned volume', () => {
  const runtime = databaseCompose({
    infraProject: 'devkit-infra',
    infraDir: '/config/infra',
    baselineDir: '/config/baselines',
    postgres: { host: 'database', port: 5432, user: 'postgres', password: 'secret' },
    databaseRuntime: {
      engine: 'postgres', version: '16.13-bookworm',
      project: 'platform-wt-report', service: 'database',
      composeFile: '/config/infra/postgres.yml', volume: 'platform-wt-report-database'
    }
  })
  assert.equal(runtime.project, 'platform-wt-report')
  assert.equal(runtime.env.DEVKIT_DATABASE_IMAGE, 'postgres:16.13-bookworm')
  assert.equal(runtime.env.DEVKIT_DATABASE_VOLUME, 'platform-wt-report-database')
  assert.equal(runtime.env.DEVKIT_DATABASE_PORT, undefined)
})

test('MariaDB checkouts keep the established server behavior', () => {
  const compose = readFileSync(new URL('../infra/mariadb.yml', import.meta.url), 'utf8')
  for (const setting of [
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_unicode_ci',
    '--sql-mode=NO_ENGINE_SUBSTITUTION',
    '--max-allowed-packet=64M',
    '--default-time-zone=America/New_York'
  ]) {
    assert.match(compose, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('checkout database definitions do not publish host ports', () => {
  for (const filename of ['mariadb.yml', 'postgres.yml']) {
    const compose = readFileSync(new URL(`../infra/${filename}`, import.meta.url), 'utf8')
    assert.doesNotMatch(compose, /^\s+ports:/m)
  }
})
