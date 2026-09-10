import assert from 'node:assert/strict'
import { test } from 'node:test'

import { baselineArchivePath } from '../src/data-baseline.mjs'

test('filesystem baselines stay backward-compatible for the default database profile', () => {
  assert.equal(
    baselineArchivePath({ baselineDir: '/baselines' }, { repoName: 'app' }),
    '/baselines/app-data.tar.gz'
  )
})

test('filesystem baselines are isolated by non-default database version profile', () => {
  assert.equal(
    baselineArchivePath({
      baselineDir: '/baselines',
      databaseProfile: { key: 'postgres-17-bookworm', isDefault: false }
    }, { repoName: 'app' }),
    '/baselines/app-postgres-17-bookworm-data.tar.gz'
  )
})
