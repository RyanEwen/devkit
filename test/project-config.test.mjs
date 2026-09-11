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
  assert.deepEqual(config.database, { engine: 'postgres', version: null, name: null })
  assert.deepEqual(config.baselinePaths, [])
  assert.deepEqual(config.worktreeFiles, [])
  assert.deepEqual(config.dependencies, [])
  assert.equal(config.browser, null)
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
  assert.deepEqual(config.database, {
    engine: 'mariadb', version: null, name: 'wyliebiz_app'
  })
})

test('a project can pin an exact database image tag', async () => {
  const maria = await withConfig(`export default { database: { engine: 'mariadb', version: '10.2', name: 'shared' } }`)
  const postgres = await withConfig(`export default { database: { engine: 'postgres', version: '17-bookworm' } }`)
  assert.equal(maria.database.version, '10.2')
  assert.equal(postgres.database.version, '17-bookworm')
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
  await assert.rejects(withConfig('export default { dependencies: "api" }'), /`dependencies` must be an array/)
  await assert.rejects(withConfig('export default { dependencies: ["api"] }'), /entry must be an object/)
  await assert.rejects(withConfig('export default { dependencies: [{ name: "Public API" }] }'), /lowercase hostname label/)
  await assert.rejects(withConfig('export default { dependencies: [{ name: "api", healthPath: "health" }] }'), /must start with/)
  await assert.rejects(withConfig('export default { dependencies: [{ name: "api" }, { name: "api" }] }'), /must not repeat/)
  await assert.rejects(withConfig('export default { browser: true }'), /`browser` must be an object/)
  await assert.rejects(withConfig('export default { browser: { path: "app" } }'), /`browser.path` must start with/)
  await assert.rejects(withConfig('export default { browser: { path: "/", healthPath: "health" } }'), /`browser.healthPath` must start with/)
  await assert.rejects(withConfig('export default { database: "mariadb" }'), /`database` must be an object/)
  await assert.rejects(withConfig('export default { database: { engine: "sqlite" } }'), /`database.engine`/)
  await assert.rejects(withConfig('export default { database: { name: "bad-name" } }'), /`database.name`/)
  await assert.rejects(withConfig('export default { database: { version: "mariadb:10.2" } }'), /`database.version`/)
  await assert.rejects(withConfig('export default { database: { version: "10/2" } }'), /`database.version`/)
  await assert.rejects(withConfig('export default 42'), /must `export default` an object/)
})

test('a project with no migrations may say so with null', async () => {
  const config = await withConfig('export default { migrationsTable: null }')
  assert.equal(config.migrationsTable, null)
})

test('a project can declare independently managed runtime dependencies', async () => {
  const config = await withConfig(`export default {
    dependencies: [{ name: 'public-api', healthPath: '/api/_health' }]
  }`)
  assert.deepEqual(config.dependencies, [{ name: 'public-api', healthPath: '/api/_health' }])
})

test('a project can opt into opening its browser URL after a separate health check', async () => {
  const config = await withConfig(`export default {
    browser: { path: '/api/', healthPath: '/api/_health' }
  }`)
  assert.deepEqual(config.browser, { path: '/api/', healthPath: '/api/_health' })
})
