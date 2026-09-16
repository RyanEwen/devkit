import assert from 'node:assert/strict'
import { test } from 'node:test'

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { baselineArchivePath, captureDataBaseline, checkoutNeedsData, restoreDataBaseline } from '../src/data-baseline.mjs'

test('filesystem baselines include the database runtime', () => {
  assert.equal(
    baselineArchivePath({
      baselineDir: '/baselines',
      databaseRuntime: { key: 'postgres-17-bookworm' }
    }, { repoName: 'app' }),
    '/baselines/app-postgres-17-bookworm-data.tar.gz'
  )
})

/** Exercise real archives so detection and tar's non-overwrite behavior stay in agreement. */
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'devkit-baseline-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const checkout = path.join(root, 'checkout')
  const config = { baselineDir: path.join(root, 'baselines') }
  const identity = { repoName: 'app' }
  mkdirSync(path.join(source, 'data/library'), { recursive: true })
  mkdirSync(path.join(source, 'apps/bridge/data'), { recursive: true })
  mkdirSync(checkout)
  writeFileSync(path.join(source, 'data/library/model.txt'), 'baseline model')
  writeFileSync(path.join(source, 'apps/bridge/data/state.json'), 'baseline identity')
  const capture = () => captureDataBaseline(config, identity, source, ['data', 'apps/bridge/data'])
  assert.equal(capture().ok, true)
  return { source, checkout, config, identity, capture }
}

test('preexisting test uploads do not hide an unrestored bridge identity', (t) => {
  const { checkout, config, identity } = fixture(t)
  mkdirSync(path.join(checkout, 'data/library/.uploads'), { recursive: true })
  writeFileSync(path.join(checkout, 'data/library/.uploads/test.part'), 'test upload')
  assert.equal(checkoutNeedsData(checkout), true)
  assert.equal(restoreDataBaseline(config, identity, checkout).ok, true)
  assert.equal(readFileSync(path.join(checkout, 'apps/bridge/data/state.json'), 'utf8'), 'baseline identity')
  assert.equal(readFileSync(path.join(checkout, 'data/library/.uploads/test.part'), 'utf8'), 'test upload')
  assert.equal(checkoutNeedsData(checkout), false)
})

test('restoring a partially populated checkout preserves its own files', (t) => {
  const { checkout, config, identity } = fixture(t)
  mkdirSync(path.join(checkout, 'apps/bridge/data'), { recursive: true })
  writeFileSync(path.join(checkout, 'apps/bridge/data/state.json'), 'checkout identity')
  assert.equal(restoreDataBaseline(config, identity, checkout).ok, true)
  assert.equal(readFileSync(path.join(checkout, 'apps/bridge/data/state.json'), 'utf8'), 'checkout identity')
  assert.equal(readFileSync(path.join(checkout, 'data/library/model.txt'), 'utf8'), 'baseline model')
})

test('a missing or corrupt archive never marks a checkout restored', (t) => {
  const { checkout, config, identity } = fixture(t)
  const archive = baselineArchivePath(config, identity)
  rmSync(archive)
  assert.equal(restoreDataBaseline(config, identity, checkout).missing, true)
  assert.equal(checkoutNeedsData(checkout), true)
  writeFileSync(archive, 'not a tar archive')
  assert.equal(restoreDataBaseline(config, identity, checkout).ok, false)
  assert.equal(checkoutNeedsData(checkout), true)
})

test('a receipt prevents reseeding deleted files until data is reset', (t) => {
  const { checkout, config, identity, capture } = fixture(t)
  assert.equal(restoreDataBaseline(config, identity, checkout).ok, true)
  rmSync(path.join(checkout, 'data/library'), { recursive: true })
  assert.equal(capture().ok, true)
  assert.equal(checkoutNeedsData(checkout), false)
  rmSync(path.join(checkout, 'data'), { recursive: true })
  assert.equal(checkoutNeedsData(checkout), true)
})

test('snapshots do not carry the source checkout restore receipt', (t) => {
  const { source, config, identity, capture } = fixture(t)
  writeFileSync(path.join(source, 'data/.devkit-baseline-restored'), 'restored\n')
  assert.equal(capture().ok, true)
  const listing = spawnSync('tar', ['-tzf', baselineArchivePath(config, identity)], { encoding: 'utf8' })
  assert.equal(listing.status, 0)
  assert.ok(!listing.stdout.includes('.devkit-baseline-restored'))
})
