import assert from 'node:assert/strict'
import { test } from 'node:test'

import { baselineArchivePath } from '../src/data-baseline.mjs'

test('filesystem baselines include the database runtime', () => {
  assert.equal(
    baselineArchivePath({
      baselineDir: '/baselines',
      databaseRuntime: { key: 'postgres-17-bookworm' }
    }, { repoName: 'app' }),
    '/baselines/app-postgres-17-bookworm-data.tar.gz'
  )
})
