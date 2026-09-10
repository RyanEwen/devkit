import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { loadProjectConfig } from '../src/project-config.mjs'

/** Writes a devkit.config.mjs into a throwaway directory and loads it. */
function withConfig(source) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'devkit-config-'))
  if (source !== null) writeFileSync(path.join(dir, 'devkit.config.mjs'), source, 'utf8')
  return loadProjectConfig(dir)
}

test('a project with no config gets defaults rather than an error', async () => {
  const config = await withConfig(null)
  assert.deepEqual(config.ports, ['web', 'api'])
  assert.deepEqual(config.database, { engine: 'postgres', name: null })
  assert.deepEqual(config.baselinePaths, [])
  assert.deepEqual(config.worktreeFiles, [])
  assert.equal(config.configPath, null)
  assert.deepEqual(config.env({}), {})
})

test('a config overrides only what it names', async () => {
  const config = await withConfig(`export default {
    ports: ['web', 'api', 'worker'],
    migrationsTable: '__drizzle_migrations'
  }`)
  assert.deepEqual(config.ports, ['web', 'api', 'worker'])
  assert.equal(config.migrationsTable, '__drizzle_migrations')
  // Untouched fields keep their defaults rather than becoming undefined.
  assert.deepEqual(config.baselinePaths, [])
  assert.deepEqual(config.worktreeFiles, [])
  assert.equal(typeof config.env, 'function')
})

test('a project can select MariaDB and preserve its established primary database name', async () => {
  const config = await withConfig(`export default {
    database: { engine: 'mariadb', name: 'wyliebiz_app' }
  }`)
  assert.deepEqual(config.database, { engine: 'mariadb', name: 'wyliebiz_app' })
})

test('env receives the derived context and returns the project\'s own variables', async () => {
  const config = await withConfig(`export default {
    ports: ['web', 'api'],
    env: ({ ports, url }) => ({ API_PORT: String(ports.api), CLIENT_ORIGIN: url })
  }`)
  assert.deepEqual(
    config.env({ ports: { web: 20000, api: 20001 }, url: 'http://x.localhost' }),
    { API_PORT: '20001', CLIENT_ORIGIN: 'http://x.localhost' }
  )
})

// Every one of these silently changes which ports or database a checkout uses, so they must fail
// loudly at load rather than produce a subtly different environment.
test('a malformed config is rejected with a message naming the field', async () => {
  await assert.rejects(withConfig('export default { ports: "web" }'), /`ports` must be an array/)
  await assert.rejects(withConfig('export default { ports: [] }'), /at least one port/)
  await assert.rejects(withConfig('export default { ports: ["web", "web"] }'), /must not repeat/)
  await assert.rejects(withConfig('export default { env: 42 }'), /`env` must be a function/)
  await assert.rejects(withConfig('export default { checks: [1] }'), /`checks` must be an array of functions/)
  await assert.rejects(withConfig('export default { worktreeFiles: ".env" }'), /`worktreeFiles` must be an array/)
  await assert.rejects(withConfig('export default { database: "mariadb" }'), /`database` must be an object/)
  await assert.rejects(withConfig('export default { database: { engine: "sqlite" } }'), /`database.engine`/)
  await assert.rejects(withConfig('export default { database: { name: "bad-name" } }'), /`database.name`/)
  await assert.rejects(withConfig('export default 42'), /must `export default` an object/)
})

test('a project with no migrations may say so with null', async () => {
  const config = await withConfig('export default { migrationsTable: null }')
  assert.equal(config.migrationsTable, null)
})
