import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { databaseCompose, infraComposeEnv } from '../src/docker.mjs'

test('infra compose receives both database services and the shared baseline directory', () => {
  const env = infraComposeEnv({
    routesDir: '/config/routes',
    baselineDir: '/config/baselines',
    proxyPort: 80,
    postgres: { port: 5432, user: 'postgres', password: 'postgres' },
    mariadb: { port: 3307, user: 'root', password: 'root', volume: 'custom-maria' }
  })

  assert.equal(env.DEVKIT_POSTGRES_PORT, '5432')
  assert.equal(env.DEVKIT_MARIADB_PORT, '3307')
  assert.equal(env.DEVKIT_MARIADB_VOLUME, 'custom-maria')
  assert.equal(env.DEVKIT_BASELINE_DIR, '/config/baselines')
})

test('a version profile gets an exact image and only its engine credentials', () => {
  const runtime = databaseCompose({
    infraProject: 'devkit-infra',
    infraDir: '/config/infra',
    baselineDir: '/config/baselines',
    mariadb: { port: 3340, user: 'root', password: 'secret' },
    databaseProfile: {
      engine: 'mariadb', version: '10.2', isDefault: false,
      project: 'devkit-db-mariadb-10-2', service: 'database',
      composeFile: '/config/infra/mariadb.yml', volume: 'devkit-mariadb-10-2'
    }
  })
  assert.equal(runtime.project, 'devkit-db-mariadb-10-2')
  assert.equal(runtime.env.DEVKIT_DATABASE_IMAGE, 'mariadb:10.2')
  assert.equal(runtime.env.DEVKIT_DATABASE_PORT, '3340')
  assert.equal(runtime.env.DEVKIT_DATABASE_PASSWORD, 'secret')
  assert.equal(runtime.env.DEVKIT_POSTGRES_PASSWORD, undefined)
})

test('versioned MariaDB profiles keep stable cross-version server behavior', () => {
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
