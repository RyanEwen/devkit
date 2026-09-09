import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { copyWorktreeFiles } from '../src/worktree-files.mjs'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-worktree-files-'))
  const primary = path.join(root, 'project')
  const worktree = path.join(root, 'worktree')
  mkdirSync(path.join(primary, '.git', 'worktrees', 'topic'), { recursive: true })
  mkdirSync(worktree)
  return {
    primary,
    worktree,
    checkout: {
      root: worktree,
      toplevel: worktree,
      gitDir: path.join(primary, '.git', 'worktrees', 'topic'),
      gitCommonDir: path.join(primary, '.git')
    },
    project: { worktreeFiles: ['.env'] }
  }
}

test('a missing worktree file is copied from the primary checkout', () => {
  const state = fixture()
  writeFileSync(path.join(state.primary, '.env'), 'TOKEN=primary\n')
  const result = copyWorktreeFiles(state)
  assert.deepEqual(result, { copied: ['.env'], missing: [] })
  assert.equal(readFileSync(path.join(state.worktree, '.env'), 'utf8'), 'TOKEN=primary\n')
})

test('an existing worktree file is never overwritten', () => {
  const state = fixture()
  writeFileSync(path.join(state.primary, '.env'), 'TOKEN=primary\n')
  writeFileSync(path.join(state.worktree, '.env'), 'TOKEN=worktree\n')
  assert.deepEqual(copyWorktreeFiles(state), { copied: [], missing: [] })
  assert.equal(readFileSync(path.join(state.worktree, '.env'), 'utf8'), 'TOKEN=worktree\n')
})

test('a source missing from both checkouts is reported without creating an empty file', () => {
  const state = fixture()
  assert.deepEqual(copyWorktreeFiles(state), { copied: [], missing: ['.env'] })
})

test('directories are copied recursively and path traversal is rejected', () => {
  const state = fixture()
  state.project.worktreeFiles = ['.local-config']
  mkdirSync(path.join(state.primary, '.local-config'))
  writeFileSync(path.join(state.primary, '.local-config', 'settings.json'), '{}\n')
  assert.deepEqual(copyWorktreeFiles(state), { copied: ['.local-config'], missing: [] })
  assert.equal(readFileSync(path.join(state.worktree, '.local-config', 'settings.json'), 'utf8'), '{}\n')

  state.project.worktreeFiles = ['../outside']
  assert.throws(() => copyWorktreeFiles(state), /must stay inside the checkout/)
})
