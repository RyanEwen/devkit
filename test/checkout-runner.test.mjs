import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { checkoutIdentity } from '../src/checkout-identity.mjs'
import { acquireCheckoutRunner, runnerFilePath, stopCheckoutRunner } from '../src/checkout-runner.mjs'


/** Creates a disposable host runner with simulated Docker, never using the machine's stack. */
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'devkit-runner-'))
  const config = { configDir: path.join(root, 'config') }
  mkdirSync(config.configDir)
  t.after(async () => {
    const directory = path.join(config.configDir, 'runners')
    if (existsSync(directory)) {
      for (const file of readdirSync(directory)) {
        const record = path.join(directory, file)
        try { process.kill(JSON.parse(readFileSync(record)).pid, 'SIGTERM') } catch {}
        const deadline = Date.now() + 3000
        while (existsSync(record) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
    }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, config }
}

/** Runs a real child to completion, retaining both streams for failure evidence. */
async function runNode(file, args, options) {
  const child = spawn(process.execPath, [file, ...args], options)
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const [code] = await once(child, 'close')
  return { code, output }
}

test('same-checkout leases reject duplicates, other worktrees remain independent', (t) => {
  const { config } = fixture(t)
  const first = acquireCheckoutRunner(config, { slug: 'repo-one' })
  const second = acquireCheckoutRunner(config, { slug: 'repo-two' })
  try {
    assert.throws(() => acquireCheckoutRunner(config, { slug: 'repo-one' }), /already running/)
    first.release()
    const replacement = acquireCheckoutRunner(config, { slug: 'repo-one' })
    first.release()
    assert.ok(existsSync(runnerFilePath(config, { slug: 'repo-one' })))
    replacement.release()
  } finally {
    first.release()
    second.release()
  }
})

test('leases from dead owners are recovered', (t) => {
  const { config } = fixture(t)
  const identity = { slug: 'repo-one' }
  mkdirSync(path.join(config.configDir, 'runners'))
  writeFileSync(runnerFilePath(config, identity), JSON.stringify({ pid: 0, token: 'dead' }))
  const runner = acquireCheckoutRunner(config, identity)
  assert.equal(JSON.parse(readFileSync(runnerFilePath(config, identity))).pid, process.pid)
  runner.release()
})

test('concurrent processes admit exactly one runner', async (t) => {
  const { root, config } = fixture(t)
  const script = path.join(root, 'contender.mjs')
  writeFileSync(script, `
    import { acquireCheckoutRunner } from ${JSON.stringify(new URL('../src/checkout-runner.mjs', import.meta.url).href)}
    try {
      acquireCheckoutRunner({ configDir: process.argv[2] }, { slug: 'same' })
      process.send('acquired')
      process.on('message', () => process.exit(0))
    } catch { process.send('rejected'); process.exit(1) }
  `)
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, [script, config.configDir], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  }))
  t.after(() => children.forEach((child) => child.kill()))
  const messages = await Promise.all(children.map(async (child) => (await once(child, 'message'))[0]))
  assert.equal(messages.filter((message) => message === 'acquired').length, 1)
  const winner = children[messages.indexOf('acquired')]
  const exited = once(winner, 'exit')
  winner.send('stop')
  await exited
})

test('background runner survives parent exit, rejects duplicates without Docker calls, and stops via down', async (t) => {
  const { root, config } = fixture(t)
  const repo = path.join(root, 'app')
  const bin = path.join(root, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  mkdirSync(path.join(config.configDir, 'infra'))
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(config.configDir, 'host.json'), '{"enabled":true}')
  writeFileSync(path.join(repo, 'devkit.config.mjs'), 'export default { migrationsTable: null }')
  const trace = path.join(root, 'docker-calls')
  writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
    const { appendFileSync } = require('node:fs')
    const args = process.argv.slice(2)
    appendFileSync(process.env.TEST_DOCKER_TRACE, JSON.stringify(args) + '\\n')
    if (args[0] === 'version') console.log('test')
    else if (args[0] === 'ps' && args.includes('-q')) console.log('test-container')
    else if (args[0] === 'exec') console.log('1')
    else if (args.includes('up') && !args.includes('-d')) {
      setInterval(() => {}, 1000)
      process.on('SIGTERM', () => process.exit(0))
    }
  `, { mode: 0o755 })
  const script = path.join(repo, 'dev.mjs')
  writeFileSync(script, `
    import { preflight, checkoutCompose, checkoutComposeLifecycle } from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)}
    const teardown = process.argv.includes('--down')
    const state = await preflight({ repoRoot: process.cwd() })
    if (!state) throw new Error('fixture host mode is disabled')
    const invocation = checkoutCompose(state, { projectDirectory: process.cwd() })
    const lifecycle = checkoutComposeLifecycle(state, invocation)
    process.exit(teardown ? lifecycle.stop() : await lifecycle.run(['up', '--remove-orphans']))
  `)
  const options = {
    cwd: repo,
    env: { ...process.env, DEVKIT: '1', DEVKIT_CONFIG_DIR: config.configDir, PATH: `${bin}:${process.env.PATH}`, TEST_DOCKER_TRACE: trace }
  }
  const identity = checkoutIdentity(repo)
  t.after(() => {
    try { process.kill(JSON.parse(readFileSync(runnerFilePath(config, identity))).pid, 'SIGTERM') } catch {}
  })
  const start = await runNode(script, ['--background'], options)
  assert.equal(start.code, 0, start.output)
  assert.match(start.output, /background runner started/)
  const runner = JSON.parse(readFileSync(runnerFilePath(config, identity)))
  assert.doesNotThrow(() => process.kill(runner.pid, 0))
  const deadline = Date.now() + 5000
  while (!readFileSync(trace, 'utf8').includes('--remove-orphans')) {
    assert.ok(Date.now() < deadline, 'fixture Compose runner did not start')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const beforeDuplicate = readFileSync(trace, 'utf8')
  const duplicate = await runNode(script, [], options)
  assert.equal(duplicate.code, 1)
  assert.match(duplicate.output, /already running/)
  assert.equal(readFileSync(trace, 'utf8'), beforeDuplicate)
  const duplicateBackground = await runNode(script, ['--background'], options)
  assert.equal(duplicateBackground.code, 1)
  assert.match(duplicateBackground.output, /exited during startup/)
  assert.equal(readFileSync(trace, 'utf8'), beforeDuplicate)
  const down = await runNode(script, ['--down'], options)
  assert.equal(down.code, 0, down.output)
  assert.equal(existsSync(runnerFilePath(config, identity)), false)
  assert.equal(existsSync(path.join(config.configDir, 'routes', `${identity.slug}.yml`)), false)
  assert.match(readFileSync(path.join(config.configDir, 'logs', `${identity.slug}.log`), 'utf8'), /already running/)
  // A child setup failure must return failure to the parent and leave the checkout restartable.
  writeFileSync(path.join(repo, 'devkit.config.mjs'), 'export default { ports: null }')
  const failedStart = await runNode(script, ['--background'], options)
  assert.equal(failedStart.code, 1)
  assert.equal(existsSync(runnerFilePath(config, identity)), false)
  writeFileSync(path.join(repo, 'devkit.config.mjs'), 'export default { migrationsTable: null }')
  const restart = await runNode(script, ['--background'], options)
  assert.equal(restart.code, 0, restart.output)
  assert.equal((await runNode(script, ['--down'], options)).code, 0)
})


test('PID reuse neither blocks a replacement nor signals the unrelated process', async (t) => {
  const { config } = fixture(t)
  const identity = { slug: 'reused-pid' }
  mkdirSync(path.join(config.configDir, 'runners'))
  writeFileSync(runnerFilePath(config, identity), JSON.stringify({
    pid: process.pid, birth: 'different-process', token: 'old'
  }))
  await stopCheckoutRunner(config, identity)
  const replacement = acquireCheckoutRunner(config, identity)
  assert.notEqual(replacement.birth, 'different-process')
  replacement.release()
})
