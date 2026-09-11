import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { deriveCheckoutIdentity } from '../src/checkout-identity.mjs'
import {
  databaseBaselineAgeDays,
  databaseBaselineLabel,
  resolveDatabaseIdentity
} from '../src/database.mjs'

function checkout(name = null) {
  const root = '/workspace/app'
  return deriveCheckoutIdentity({
    gitDir: name ? `${root}/.git/worktrees/${name}` : '.git',
    gitCommonDir: '.git',
    toplevel: name ? `${root}/.worktrees/${name}` : root,
    root
  })
}

const mariaProject = { database: { engine: 'mariadb', name: 'wyliebiz_app' } }

test('database name overrides are safe to reuse inside isolated checkout servers', () => {
  const primary = resolveDatabaseIdentity(checkout(), mariaProject)
  const worktree = resolveDatabaseIdentity(checkout('issue-42'), mariaProject)

  assert.equal(primary.databaseName, 'wyliebiz_app')
  assert.equal(primary.databaseBaseName, 'wyliebiz_app')
  assert.equal(worktree.databaseName, 'wyliebiz_app')
  assert.equal(worktree.hostname, 'issue-42.app.localhost')
})

test('MariaDB baselines are per-clone dump files with measurable age', () => {
  const baselineDir = mkdtempSync(path.join(os.tmpdir(), 'devkit-mariadb-baseline-'))
  const config = { baselineDir, databaseRuntime: { key: 'mariadb-12-3-2' } }
  const identity = resolveDatabaseIdentity(checkout(), mariaProject)
  const baseline = databaseBaselineLabel(config, identity, mariaProject)

  assert.equal(baseline, path.join(baselineDir, 'app-mariadb-12-3-2.sql'))
  assert.equal(databaseBaselineAgeDays(config, identity, mariaProject), null)

  mkdirSync(path.dirname(baseline), { recursive: true })
  writeFileSync(baseline, '-- baseline')
  const now = Date.now()
  utimesSync(baseline, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000))
  assert.ok(Math.abs(databaseBaselineAgeDays(config, identity, mariaProject, { now }) - 2) < 0.001)
})

test('database versions use separate baselines', () => {
  const baselineDir = mkdtempSync(path.join(os.tmpdir(), 'devkit-mariadb-version-baseline-'))
  const identity = resolveDatabaseIdentity(checkout(), mariaProject)
  const versioned = databaseBaselineLabel({
    baselineDir,
    databaseRuntime: { key: 'mariadb-10-2' }
  }, identity, mariaProject)
  assert.equal(versioned, path.join(baselineDir, 'app-mariadb-10-2.sql'))
})

test('PostgreSQL uses a portable dump baseline', () => {
  const baselineDir = mkdtempSync(path.join(os.tmpdir(), 'devkit-postgres-checkout-baseline-'))
  const identity = resolveDatabaseIdentity(checkout(), {
    database: { engine: 'postgres' }
  })
  const config = {
    baselineDir,
    databaseRuntime: { engine: 'postgres', key: 'postgres-16-bookworm' }
  }
  assert.equal(
    databaseBaselineLabel(config, identity, { database: { engine: 'postgres' } }),
    path.join(baselineDir, 'app-postgres-16-bookworm.sql')
  )
})
