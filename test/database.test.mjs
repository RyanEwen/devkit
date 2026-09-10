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

test('database name overrides adopt the primary schema and namespace worktrees beneath it', () => {
  const primary = resolveDatabaseIdentity(checkout(), mariaProject)
  const worktree = resolveDatabaseIdentity(checkout('issue-42'), mariaProject)

  assert.equal(primary.databaseName, 'wyliebiz_app')
  assert.equal(primary.databaseBaseName, 'wyliebiz_app')
  assert.equal(worktree.databaseName, 'wyliebiz_app_wt_issue_42')
  assert.equal(worktree.hostname, 'issue-42.app.localhost')
})

test('MariaDB baselines are per-clone dump files with measurable age', () => {
  const baselineDir = mkdtempSync(path.join(os.tmpdir(), 'devkit-mariadb-baseline-'))
  const config = { baselineDir }
  const identity = resolveDatabaseIdentity(checkout(), mariaProject)
  const baseline = databaseBaselineLabel(config, identity, mariaProject)

  assert.equal(baseline, path.join(baselineDir, 'app-mariadb.sql'))
  assert.equal(databaseBaselineAgeDays(config, identity, mariaProject), null)

  mkdirSync(path.dirname(baseline), { recursive: true })
  writeFileSync(baseline, '-- baseline')
  const now = Date.now()
  utimesSync(baseline, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000))
  assert.ok(Math.abs(databaseBaselineAgeDays(config, identity, mariaProject, { now }) - 2) < 0.001)
})
