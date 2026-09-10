import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { test } from 'node:test'

import {
  dropDatabase,
  ensureCheckoutDatabase,
  findOrphanDatabases,
  resolveDatabaseIdentity,
  snapshotBaseline
} from '../src/database.mjs'
import { mariadbSql } from '../src/docker.mjs'

const enabled = process.env.DEVKIT_MARIADB_INTEGRATION === '1'

test('MariaDB create, snapshot, clone, isolation, reset, prune, and drop lifecycle', { skip: !enabled }, async () => {
  const config = {
    infraProject: process.env.DEVKIT_TEST_INFRA_PROJECT ?? 'devkit-mariadb-test',
    baselineDir: process.env.DEVKIT_TEST_BASELINE_DIR ?? '/tmp/devkit-mariadb-test-baselines',
    mariadb: { host: '127.0.0.1', port: 33307, user: 'root', password: 'root' }
  }
  const project = { database: { engine: 'mariadb', name: 'devkit_integration' } }
  const checkout = {
    repoName: 'devkit-integration',
    worktreeName: null,
    isPrimary: true,
    hostname: 'devkit-integration.localhost'
  }
  const primary = resolveDatabaseIdentity(checkout, project)
  const worktree = resolveDatabaseIdentity(
    { ...checkout, isPrimary: false, worktreeName: 'feature', hostname: 'feature.devkit-integration.localhost' },
    project
  )

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (mariadbSql(config, 'select 1').ok) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(mariadbSql(config, 'select 1').ok, true, 'MariaDB did not become ready')

  dropDatabase(config, worktree.databaseName, project)
  dropDatabase(config, primary.databaseName, project)
  rmSync(`${config.baselineDir}/${checkout.repoName}-mariadb.sql`, { force: true })
  rmSync(`${config.baselineDir}/${checkout.repoName}-mariadb.sql.prev`, { force: true })

  assert.deepEqual(ensureCheckoutDatabase(config, primary, project), {
    created: true,
    name: primary.databaseName,
    sourced: 'empty'
  })
  assert.equal(
    mariadbSql(
      config,
      'create table sample (id int primary key, value varchar(50)); insert into sample values (1, \'primary\')',
      { database: primary.databaseName }
    ).ok,
    true
  )

  const snapshot = snapshotBaseline(config, primary, project)
  assert.equal(snapshot.ok, true, snapshot.error)
  assert.equal(ensureCheckoutDatabase(config, worktree, project).sourced, 'baseline')
  assert.equal(mariadbSql(config, 'select value from sample where id = 1', { database: worktree.databaseName }).stdout, 'primary')

  assert.equal(mariadbSql(config, "insert into sample values (2, 'worktree')", { database: worktree.databaseName }).ok, true)
  assert.equal(mariadbSql(config, 'select count(*) from sample', { database: primary.databaseName }).stdout, '1')
  assert.deepEqual(findOrphanDatabases(config, worktree, [primary.databaseName], project), [worktree.databaseName])

  assert.equal(mariadbSql(config, "insert into sample values (3, 'new baseline')", { database: primary.databaseName }).ok, true)
  const refreshed = snapshotBaseline(config, primary, project)
  assert.equal(refreshed.ok, true, refreshed.error)
  assert.equal(existsSync(refreshed.previous), true)

  assert.equal(dropDatabase(config, worktree.databaseName, project).ok, true)
  assert.equal(ensureCheckoutDatabase(config, worktree, project).sourced, 'baseline')
  assert.equal(mariadbSql(config, 'select count(*) from sample', { database: worktree.databaseName }).stdout, '2')
  assert.equal(mariadbSql(config, 'select value from sample where id = 3', { database: worktree.databaseName }).stdout, 'new baseline')

  assert.equal(dropDatabase(config, worktree.databaseName, project).ok, true)
  assert.equal(dropDatabase(config, primary.databaseName, project).ok, true)
})
