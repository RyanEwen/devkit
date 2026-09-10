import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { databaseProfile, selectDatabaseProfile } from '../src/database-profile.mjs'
import { checkoutDatabase } from '../src/config.mjs'

function config() {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'devkit-profiles-'))
  return {
    configDir,
    infraDir: '/devkit/infra',
    infraProject: 'devkit-infra',
    postgres: { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'pg-secret' },
    mariadb: { host: '127.0.0.1', port: 3307, user: 'root', password: 'maria-secret', volume: 'devkit-mariadb' }
  }
}

test('absent versions preserve the original shared services, ports and volumes', () => {
  const host = config()
  const pg = databaseProfile(host, { database: { engine: 'postgres' } })
  const maria = databaseProfile(host, { database: { engine: 'mariadb' } })
  assert.deepEqual({ version: pg.version, project: pg.project, service: pg.service, port: pg.connection.port }, {
    version: '16-bookworm', project: 'devkit-infra', service: 'postgres', port: 5432
  })
  assert.deepEqual({ version: maria.version, project: maria.project, service: maria.service, port: maria.connection.port, volume: maria.volume }, {
    version: '12.3.2', project: 'devkit-infra', service: 'mariadb', port: 3307, volume: 'devkit-mariadb'
  })
})

test('the explicit default tag also reuses the backward-compatible service', () => {
  const pg = databaseProfile(config(), { database: { engine: 'postgres', version: '16-bookworm' } })
  assert.equal(pg.isDefault, true)
  assert.equal(pg.service, 'postgres')
})

test('multiple MariaDB and PostgreSQL versions receive stable independent profiles', () => {
  const host = config()
  const maria102 = selectDatabaseProfile(host, { database: { engine: 'mariadb', version: '10.2' } })
  const maria106 = selectDatabaseProfile(host, { database: { engine: 'mariadb', version: '10.6' } })
  const pg15 = selectDatabaseProfile(host, { database: { engine: 'postgres', version: '15-bookworm' } })
  const pg17 = selectDatabaseProfile(host, { database: { engine: 'postgres', version: '17-bookworm' } })

  assert.equal(maria102.mariadb.port, 3340)
  assert.equal(maria106.mariadb.port, 3341)
  assert.equal(pg15.postgres.port, 5540)
  assert.equal(pg17.postgres.port, 5541)
  assert.equal(databaseProfile(host, { database: { engine: 'mariadb', version: '10.2' } }).connection.port, 3340)
  assert.notEqual(maria102.databaseProfile.project, maria106.databaseProfile.project)
  assert.notEqual(pg15.databaseProfile.volume, pg17.databaseProfile.volume)
  assert.equal(checkoutDatabase(maria102, 'shared', 'mariadb').version, '10.2')

  const registry = JSON.parse(readFileSync(path.join(host.configDir, 'database-profiles.json'), 'utf8'))
  assert.deepEqual(Object.keys(registry).sort(), [
    'mariadb-10-2', 'mariadb-10-6', 'postgres-15-bookworm', 'postgres-17-bookworm'
  ])
})

test('profile slugs cannot silently alias two exact image tags', () => {
  const host = config()
  databaseProfile(host, { database: { engine: 'postgres', version: '17.1' } })
  assert.throws(
    () => databaseProfile(host, { database: { engine: 'postgres', version: '17-1' } }),
    /collides/
  )
})

test('a malformed persisted allocation is rejected instead of targeting an unsafe container', () => {
  const host = config()
  writeFileSync(path.join(host.configDir, 'database-profiles.json'), JSON.stringify({
    'postgres-17': { engine: 'postgres', version: '17', port: 80, project: 'other', volume: 'unsafe' }
  }))
  assert.throws(
    () => databaseProfile(host, { database: { engine: 'postgres', version: '17' } }),
    /invalid database profile/
  )
})

test('a lock left by a dead allocator is recovered safely', () => {
  const host = config()
  const lock = path.join(host.configDir, 'database-profiles.json.lock')
  mkdirSync(lock)
  writeFileSync(path.join(lock, 'owner'), `${JSON.stringify({ pid: 2147483647, createdAt: Date.now() })}\n`)
  const profile = databaseProfile(host, { database: { engine: 'mariadb', version: '10.2' } })
  assert.equal(profile.connection.port, 3340)
})

test('concurrent allocators preserve both profiles and assign distinct ports', async () => {
  const host = config()
  const moduleUrl = pathToFileURL(path.resolve('src/database-profile.mjs')).href
  const source = `
    import { databaseProfile } from ${JSON.stringify(moduleUrl)};
    const config = JSON.parse(process.argv[1]);
    databaseProfile(config, { database: { engine: 'postgres', version: process.argv[2] } });
  `
  await Promise.all([
    child(source, JSON.stringify(host), '14-bookworm'),
    child(source, JSON.stringify(host), '15-bookworm')
  ])
  const registry = JSON.parse(readFileSync(path.join(host.configDir, 'database-profiles.json'), 'utf8'))
  assert.deepEqual([
    registry['postgres-14-bookworm'].port,
    registry['postgres-15-bookworm'].port
  ].sort(), [5540, 5541])
})

function child(source, serializedConfig, version) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, ['--input-type=module', '-e', source, serializedConfig, version])
    let stderr = ''
    childProcess.stderr.on('data', (chunk) => { stderr += chunk })
    childProcess.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)))
  })
}
