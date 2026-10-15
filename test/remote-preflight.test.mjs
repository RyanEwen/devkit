import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('preflight, doctor, and devproxy share preferred remote origins while preserving localhost', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'devkit-remote-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'app')
  const configDir = path.join(root, 'config')
  const bin = path.join(root, 'bin')
  for (const directory of [repo, configDir, bin, path.join(configDir, 'infra')]) mkdirSync(directory, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'devkit.config.mjs'), `export default {
    migrationsTable: null,
    env: ({ url, urls }) => ({ CLIENT_ORIGIN: url, CLIENT_ORIGINS: urls.join(',') })
  }`)
  const trace = path.join(root, 'docker-calls')
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
    const { appendFileSync } = require('node:fs')
    const args = process.argv.slice(2)
    appendFileSync(process.env.TEST_DOCKER_TRACE, JSON.stringify({ args, port: process.env.DEVKIT_PROXY_PORT }) + '\\n')
    if (args[0] === 'version') console.log('test')
    else if (args[0] === 'ps' && args.includes('-q')) console.log('test-container')
    else if (args[0] === 'ps') console.log('proxy\\ndatabase')
    else if (args[0] === 'exec') console.log('1')
  `, { mode: 0o755 })
  const script = path.join(repo, 'dev.mjs')
  writeFileSync(script, `
    import { preflight } from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)}
    const state = await preflight({ repoRoot: process.cwd(), log: null, checkDependencies: false })
    console.log(JSON.stringify({ identity: state.identity, url: state.url, urls: state.urls, env: state.env }))
    state.runner.release()
  `)
  const options = {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, DEVKIT: '1', DEVKIT_OPEN_BROWSER: '0', DEVKIT_CONFIG_DIR: configDir,
      PATH: `${bin}:${process.env.PATH}`, TEST_DOCKER_TRACE: trace }
  }
  const run = (file, args = []) => {
    const result = spawnSync(process.execPath, [file, ...args], options)
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    return result.stdout
  }
  const marker = path.join(configDir, 'host.json')
  writeFileSync(marker, '{"enabled":true}')
  const local = JSON.parse(run(script))
  assert.equal(local.url, 'http://app.localhost')
  assert.deepEqual(local.urls, ['http://app.localhost'])
  const remote = {
    enabled: true, secondaryDomains: ['server.home'], preferredDomain: 'server.home',
    proxyPort: 18080, publicPort: 80, proxyNetwork: 'host', proxyBindAddress: '172.24.0.1'
  }
  writeFileSync(marker, JSON.stringify(remote))
  const state = JSON.parse(run(script))
  assert.equal(state.url, 'http://app.server.home')
  assert.deepEqual(state.urls, ['http://app.server.home', 'http://app.localhost'])
  assert.equal(state.env.CLIENT_ORIGIN, state.url)
  assert.deepEqual(JSON.parse(state.env.DEVKIT_URLS), state.urls)
  assert.equal(state.env.VITE_DEV_ALLOWED_HOSTS, 'app.server.home,app.localhost,localhost,127.0.0.1')
  assert.equal(state.identity.databaseName, local.identity.databaseName)
  const route = readFileSync(path.join(configDir, 'routes', 'app.yml'), 'utf8')
  assert.match(route, /Host\(`app\.server\.home`\) \|\| Host\(`app\.localhost`\)/)
  const calls = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(calls.some(({ args, port }) => port === '18080' && args.some((arg) => arg.endsWith('compose.host.yml'))))

  const cli = fileURLToPath(new URL('../bin/devkit.mjs', import.meta.url))
  const doctor = run(cli, ['doctor'])
  assert.match(doctor, /http:\/\/app\.server\.home/)
  assert.match(doctor, /alternate url\s+http:\/\/app\.localhost/)
  assert.match(run(cli, ['nginx', '--allow', '192.168.2.0/24']), /server_name \*\.localhost \*\.server\.home;/)

  const devproxy = fileURLToPath(new URL('../bin/devproxy.mjs', import.meta.url))
  const added = run(devproxy, ['add', 'manual', '32123'])
  assert.match(added, /http:\/\/manual\.server\.home/)
  assert.match(added, /http:\/\/manual\.localhost/)
  const manualRoute = path.join(configDir, 'routes', 'devproxy-manual.localhost.yml')
  assert.ok(existsSync(manualRoute))
  run(devproxy, ['rm', 'manual.server.home'])
  assert.equal(existsSync(manualRoute), false)
})
