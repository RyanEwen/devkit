import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { composeDown, databaseCompose, infraComposeEnv } from '../src/docker.mjs'

test('empty Compose teardown skips down, but probes containers and networks', () => {
  const calls = []
  const result = composeDown('devkit-infra', ['/infra/compose.yml'], {
    runCommand: (command, args) => {
      calls.push(args)
      return { status: 0, stdout: '' }
    }
  })

  assert.equal(result, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].slice(0, 3), ['ps', '-a', '-q'])
  assert.deepEqual(calls[1].slice(0, 3), ['network', 'ls', '-q'])
})

test('Compose teardown cleans stopped containers and networks with the configured arguments and environment', () => {
  for (const resource of ['container', 'network']) {
    const calls = []
    const env = { DEVKIT_ROUTES_DIR: '/config/routes' }
    const result = composeDown('devkit-infra', ['/infra/compose.yml'], {
      cwd: '/config/infra', env,
      runCommand: (command, args, options) => {
        calls.push({ args, options })
        if (args[0] === 'compose') return { status: 0, stdout: '', stderr: '' }
        const ownsResource = (args[0] === 'ps' && resource === 'container') ||
          (args[0] === 'network' && resource === 'network')
        return { status: 0, stdout: ownsResource ? 'resource-id\n' : '' }
      }
    })

    assert.equal(result, true)
    assert.equal(calls.length, 3)
    assert.deepEqual(calls[2].args, ['compose', '-p', 'devkit-infra', '-f', '/infra/compose.yml', 'down', '--remove-orphans'])
    assert.equal(calls[2].options.cwd, '/config/infra')
    assert.deepEqual(calls[2].options.env, { ...process.env, ...env })
  }
})

test('Compose teardown still cleans up when either resource probe fails', () => {
  for (const failedProbe of ['ps', 'network']) {
    const calls = []
    const result = composeDown('devkit-infra', ['/infra/compose.yml'], {
      runCommand: (_command, args) => {
        calls.push(args)
        if (args[0] === 'compose') return { status: 0, stdout: '', stderr: '' }
        return args[0] === failedProbe
          ? { status: 1, stdout: '', stderr: 'probe failed' }
          : { status: 0, stdout: '' }
      }
    })
    assert.equal(result, true)
    assert.equal(calls.at(-1)[0], 'compose')
  }
})

test('Compose teardown retains cleanup failures when resources exist', () => {
  const result = composeDown('devkit-infra', ['/infra/compose.yml'], {
    runCommand: (_command, args) => args[0] === 'ps'
      ? { status: 0, stdout: 'stopped-container\n' }
      : args[0] === 'network'
        ? { status: 0, stdout: '' }
        : { status: 1, stdout: '', stderr: 'daemon unavailable' }
  })
  assert.equal(result, false)
})

test('infra compose receives only proxy settings', () => {
  const env = infraComposeEnv({
    routesDir: '/config/routes',
    baselineDir: '/config/baselines',
    proxyPort: 80,
    postgres: { port: 5432, user: 'postgres', password: 'postgres' },
    mariadb: { port: 3307, user: 'root', password: 'root', volume: 'custom-maria' }
  })

  assert.deepEqual(env, { DEVKIT_ROUTES_DIR: '/config/routes', DEVKIT_PROXY_PORT: '80',
    DEVKIT_PROXY_BIND_ADDRESS: '127.0.0.1' })
})

test('a checkout database gets an exact image and only its engine credentials', () => {
  const runtime = databaseCompose({
    infraProject: 'devkit-infra',
    infraDir: '/config/infra',
    baselineDir: '/config/baselines',
    mariadb: { port: 3340, user: 'root', password: 'secret' },
    databaseRuntime: {
      engine: 'mariadb', version: '10.2',
      project: 'app-wt-issue', service: 'database',
      composeFile: '/config/infra/mariadb.yml', volume: 'app-wt-issue-database', hostPort: null
    }
  })
  assert.equal(runtime.project, 'app-wt-issue')
  assert.equal(runtime.env.DEVKIT_DATABASE_IMAGE, 'mariadb:10.2')
  assert.equal(runtime.env.DEVKIT_DATABASE_PORT, undefined)
  assert.equal(runtime.env.DEVKIT_DATABASE_PASSWORD, 'secret')
  assert.equal(runtime.env.DEVKIT_POSTGRES_PASSWORD, undefined)
})

test('a checkout database has no published port and uses the checkout-owned volume', () => {
  const runtime = databaseCompose({
    infraProject: 'devkit-infra',
    infraDir: '/config/infra',
    baselineDir: '/config/baselines',
    postgres: { host: 'database', port: 5432, user: 'postgres', password: 'secret' },
    databaseRuntime: {
      engine: 'postgres', version: '16.13-bookworm',
      project: 'platform-wt-report', service: 'database',
      composeFile: '/config/infra/postgres.yml', volume: 'platform-wt-report-database', hostPort: null
    }
  })
  assert.equal(runtime.project, 'platform-wt-report')
  assert.equal(runtime.env.DEVKIT_DATABASE_IMAGE, 'postgres:16.13-bookworm')
  assert.equal(runtime.env.DEVKIT_DATABASE_VOLUME, 'platform-wt-report-database')
  assert.equal(runtime.env.DEVKIT_DATABASE_PORT, undefined)
})

test('opt-in host access adds a loopback publishing overlay', () => {
  const runtime = databaseCompose({
    infraDir: '/config/infra',
    baselineDir: '/config/baselines',
    postgres: { host: 'database', port: 5432, user: 'postgres', password: 'secret' },
    databaseRuntime: {
      engine: 'postgres', version: '16.13-bookworm', project: 'platform', service: 'database',
      composeFile: '/config/infra/postgres.yml', volume: 'platform-database', hostPort: 20009
    }
  })
  assert.equal(runtime.files[0], '/config/infra/postgres.yml')
  assert.match(runtime.files[1], /\/infra\/database-host\.yml$/)
  assert.equal(runtime.env.DEVKIT_DATABASE_HOST_PORT, '20009')
  assert.equal(runtime.env.DEVKIT_DATABASE_INTERNAL_PORT, '5432')
})

test('MariaDB checkouts keep the established server behavior', () => {
  const compose = readFileSync(new URL('../infra/mariadb.yml', import.meta.url), 'utf8')
  for (const setting of [
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_unicode_ci',
    '--sql-mode=NO_ENGINE_SUBSTITUTION',
    '--max-allowed-packet=64M',
    '--default-time-zone=America/New_York'
  ]) {
    assert.match(compose, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('checkout database definitions do not publish host ports', () => {
  for (const filename of ['mariadb.yml', 'postgres.yml']) {
    const compose = readFileSync(new URL(`../infra/${filename}`, import.meta.url), 'utf8')
    assert.doesNotMatch(compose, /^\s+ports:/m)
  }
})

test('the shared proxy does not restart after Docker Desktop wakes', () => {
  const compose = readFileSync(new URL('../infra/compose.yml', import.meta.url), 'utf8')
  assert.match(compose, /^\s+restart: "no"$/m)
  assert.doesNotMatch(compose, /^\s+restart: always$/m)
})
