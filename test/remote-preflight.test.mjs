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
  assert.equal(local.env.DEVKIT_PROXY_ADDRESS, 'host-gateway')
  const remote = {
    enabled: true, secondaryDomains: ['server.home'], preferredDomain: 'server.home',
    proxyPort: 18080, publicPort: 80, proxyNetwork: 'host', proxyBindAddress: '172.24.0.1'
  }
  writeFileSync(marker, JSON.stringify(remote))
  const state = JSON.parse(run(script))
  assert.equal(state.url, 'http://app.server.home')
  assert.deepEqual(state.urls, ['http://app.server.home', 'http://app.localhost:18080'])
  assert.equal(state.env.CLIENT_ORIGIN, state.url)
  assert.equal(state.env.DEVKIT_PROXY_ADDRESS, '172.24.0.1')
  assert.deepEqual(JSON.parse(state.env.DEVKIT_URLS), state.urls)
  assert.equal(state.env.VITE_DEV_ALLOWED_HOSTS, 'app.server.home,app.localhost,localhost,127.0.0.1')
  assert.equal(state.identity.databaseName, local.identity.databaseName)
  const route = readFileSync(path.join(configDir, 'routes', 'app.yml'), 'utf8')
  assert.match(route, /Host\(`app\.server\.home`\) \|\| Host\(`app\.localhost`\)/)
  const calls = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(calls.some(({ args, port }) => port === '18080' && args.some((arg) => arg.endsWith('compose.host.yml'))))

  const cli = fileURLToPath(new URL('../bin/devkit.mjs', import.meta.url))
  const checked = spawnSync(process.execPath, [cli, 'doctor'], options)
  assert.equal(checked.status, 1)
  const doctor = checked.stdout
  assert.match(doctor, /127\.0\.0\.1:18080 not answering/)
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

test('preflight repairs the proxy before dependency probes without requiring remote DNS', async (t) => {
  const { createServer } = await import('node:http')
  const { promisify } = await import('node:util')
  const { execFile } = await import('node:child_process')
  const root = mkdtempSync(path.join(tmpdir(), 'devkit-dependency-order-'))
  const repo = path.join(root, 'app'), configDir = path.join(root, 'config'), bin = path.join(root, 'bin')
  for (const directory of [repo, configDir, bin, path.join(configDir, 'infra')]) mkdirSync(directory, { recursive: true })
  const trace = path.join(root, 'docker-calls')
  const requests = []
  const server = createServer((request, response) => {
    const calls = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(calls.some((args) => args.includes('up') && args.at(-1) === 'proxy'), 'proxy repaired before health probe')
    requests.push({ host: request.headers.host, path: request.url })
    response.writeHead(204).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }) })
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'devkit.config.mjs'), `export default { migrationsTable: null, dependencies: [{ name: 'api', healthPath: '/health' }] }`)
  writeFileSync(path.join(configDir, 'host.json'), JSON.stringify({
    enabled: true, proxyNetwork: 'host', proxyBindAddress: '192.0.2.99',
    secondaryDomains: ['unresolvable.invalid'], preferredDomain: 'unresolvable.invalid',
    proxyPort: server.address().port, publicScheme: 'https', publicPort: 8443
  }))
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
    const { appendFileSync } = require('node:fs')
    const args = process.argv.slice(2)
    appendFileSync(process.env.TEST_DOCKER_TRACE, JSON.stringify(args) + '\\n')
    if (args[0] === 'version') console.log('test')
    else if (args[0] === 'ps' && args.includes('-q')) console.log('test-container')
    else if (args[0] === 'exec') console.log('1')
  `, { mode: 0o755 })
  const script = path.join(repo, 'dev.mjs')
  writeFileSync(script, `
    import { preflight } from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)}
    const state = await preflight({ repoRoot: process.cwd(), log: null })
    state.runner.release()
  `)
  await promisify(execFile)(process.execPath, [script], {
    cwd: repo, env: { ...process.env, DEVKIT: '1', DEVKIT_OPEN_BROWSER: '0', DEVKIT_CONFIG_DIR: configDir,
      PATH: `${bin}:${process.env.PATH}`, TEST_DOCKER_TRACE: trace }
  })
  assert.deepEqual(requests, [{ host: 'api.unresolvable.invalid:8443', path: '/health' }])
})

test('a selected dependency worktree drives startup checks, env origins and doctor; a damaged choice never falls back', async (t) => {
  const { createServer } = await import('node:http')
  const { promisify } = await import('node:util')
  const { execFile } = await import('node:child_process')
  const { realpathSync } = await import('node:fs')
  const root = mkdtempSync(path.join(tmpdir(), 'devkit-dependency-target-'))
  const repo = path.join(root, 'app'), configDir = path.join(root, 'config'), bin = path.join(root, 'bin')
  for (const directory of [repo, configDir, bin, path.join(configDir, 'infra')]) mkdirSync(directory, { recursive: true })
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.headers.host)
    response.writeHead(204).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }) })
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'devkit.config.mjs'), `export default {
    migrationsTable: null,
    dependencies: [{ name: 'api', healthPath: '/health' }],
    env: ({ dependencyOrigins }) => ({ API_ORIGIN: dependencyOrigins.api })
  }`)
  writeFileSync(path.join(configDir, 'host.json'), JSON.stringify({ enabled: true, proxyPort: server.address().port }))
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
    const args = process.argv.slice(2)
    if (args[0] === 'version') console.log('test')
    else if (args[0] === 'ps' && args.includes('-q')) console.log('test-container')
    else if (args[0] === 'exec') console.log('1')
  `, { mode: 0o755 })
  const script = path.join(repo, 'dev.mjs')
  writeFileSync(script, `
    import { preflight } from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)}
    const state = await preflight({ repoRoot: process.cwd(), log: null, teardown: process.argv.includes('--down') })
    console.log(JSON.stringify({ origin: state.env.API_ORIGIN, lines: state.lines }))
    state.runner?.release()
  `)
  const env = { ...process.env, DEVKIT: '1', DEVKIT_OPEN_BROWSER: '0', DEVKIT_CONFIG_DIR: configDir, PATH: `${bin}:${process.env.PATH}` }
  const run = async (args = []) => JSON.parse((await promisify(execFile)(process.execPath, [script, ...args], { cwd: repo, env })).stdout)

  const targets = path.join(configDir, 'dependency-targets', 'app.json')
  mkdirSync(path.dirname(targets), { recursive: true })
  writeFileSync(targets, JSON.stringify({ checkout: realpathSync(repo), dependencies: { api: 'pickup-limits' } }))
  const started = await run()
  assert.deepEqual(requests, [`pickup-limits.api.localhost:${server.address().port}`])
  assert.equal(started.origin, `http://pickup-limits.api.localhost:${server.address().port}`)
  assert.ok(started.lines.some((line) => line.startsWith('api uses its pickup-limits worktree')))

  writeFileSync(targets, '{damaged')
  requests.length = 0
  await assert.rejects(promisify(execFile)(process.execPath, [script], { cwd: repo, env }), (error) => error.stderr.includes(targets))
  assert.deepEqual(requests, [], 'a damaged choice is not replaced by the primary checkout')
  const stopped = await run(['--down'])
  assert.ok(stopped.lines.some((line) => line.includes('ignored while stopping')))

  const cli = fileURLToPath(new URL('../bin/devkit.mjs', import.meta.url))
  const doctor = spawnSync(process.execPath, [cli, 'doctor'], { cwd: repo, env, encoding: 'utf8' })
  assert.match(doctor.stdout, /needs api\s+checkout unknown until the targets file is fixed/)
  assert.deepEqual(requests, [], 'doctor does not probe the primary checkout instead')
})
