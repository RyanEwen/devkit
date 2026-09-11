import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkoutDatabase } from '../src/config.mjs'
import { selectDatabaseRuntime } from '../src/database-runtime.mjs'

const host = {
  infraDir: '/devkit/infra',
  postgres: { user: 'postgres', password: 'pg-secret' },
  mariadb: { user: 'root', password: 'maria-secret' }
}

test('a checkout owns its database runtime and uses the fixed container address', () => {
  const selected = selectDatabaseRuntime(
    host,
    { database: { engine: 'mariadb', version: '10.2.44' } },
    { composeProject: 'app-wt-issue-42' }
  )

  assert.deepEqual(selected.databaseRuntime, {
    engine: 'mariadb',
    version: '10.2.44',
    key: 'mariadb-10-2-44',
    project: 'app-wt-issue-42',
    service: 'database',
    composeFile: '/devkit/infra/mariadb.yml',
    volume: 'app-wt-issue-42-database'
  })
  assert.equal(selected.mariadb.host, 'database')
  assert.equal(selected.mariadb.port, 3306)
  assert.equal(checkoutDatabase(selected, 'app', 'mariadb').version, '10.2.44')
})

test('an omitted version uses the engine default', () => {
  const selected = selectDatabaseRuntime(
    host,
    { database: { engine: 'postgres' } },
    { composeProject: 'app' }
  )
  assert.equal(selected.databaseRuntime.version, '16-bookworm')
  assert.equal(selected.postgres.port, 5432)
})
