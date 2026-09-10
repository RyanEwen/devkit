import assert from 'node:assert/strict'
import { test } from 'node:test'

import { infraComposeEnv } from '../src/docker.mjs'

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
