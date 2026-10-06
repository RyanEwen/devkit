import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { checkoutComposeLifecycle } from '../src/checkout-compose-lifecycle.mjs'

class FakeChild extends EventEmitter {
  exitCode = null
  signalCode = null
  killedWith = null

  kill(signal) {
    this.killedWith = signal
  }
}

function fixture({ downStatus = 0, spawnError = null, downError = null } = {}) {
  const child = new FakeChild()
  const processTarget = new EventEmitter()
  const calls = []
  const releases = []
  const leaseEvents = []
  const runner = { release() { leaseEvents.push('lease-released') } }
  processTarget.once('exit', runner.release)
  const runtime = {
    process: processTarget,
    spawn(command, args, options) {
      if (spawnError) throw spawnError
      calls.push({ type: 'spawn', command, args, options })
      return child
    },
    spawnSync(command, args, options) {
      leaseEvents.push('stack-stopped')
      if (downError) throw downError
      calls.push({ type: 'spawnSync', command, args, options })
      return { status: downStatus, signal: null }
    }
  }
  const state = {
    runner,
    config: { routesDir: '/tmp/devkit-lifecycle-test-routes' },
    identity: { slug: 'app-test' }
  }
  const invocation = {
    command: 'docker',
    args: ['compose', '-p', 'app-test'],
    cwd: '/workspace',
    env: { TEST: '1' }
  }

  return {
    calls,
    leaseEvents,
    child,
    lifecycle: checkoutComposeLifecycle(state, invocation, {
      profiles: ['slicer'],
      runtime,
      releaseProxy(config, identity) {
        leaseEvents.push('proxy-released')
        releases.push({ config, identity })
        return true
      }
    }),
    processTarget,
    releases
  }
}

test('stop includes configured profiles and tears down only once', () => {
  const { calls, lifecycle, releases } = fixture()

  assert.equal(lifecycle.stop(), 0)
  assert.equal(lifecycle.stop(), 0)
  assert.deepEqual(calls.map(({ type, args }) => ({ type, args })), [{
    type: 'spawnSync',
    args: ['compose', '-p', 'app-test', '--profile', 'slicer', 'down', '--remove-orphans']
  }])
  assert.equal(releases.length, 1)
})

test('run translates Ctrl-C and tears down the complete stack', async () => {
  const { calls, child, lifecycle, processTarget } = fixture()
  const result = lifecycle.run(['up', '--remove-orphans'])

  processTarget.emit('SIGINT')
  assert.equal(child.killedWith, 'SIGINT')
  child.emit('close', null, 'SIGINT')

  assert.equal(await result, 130)
  assert.equal(calls[0].type, 'spawn')
  assert.equal(calls[1].type, 'spawnSync')
})

test('a failed cleanup changes a successful foreground result', async () => {
  const { child, lifecycle } = fixture({ downStatus: 17 })
  const result = lifecycle.run(['run', '--rm', 'node'])

  child.emit('close', 0, null)

  assert.equal(await result, 17)
})


test('exit cleanup keeps ownership until the stack and proxy have stopped', () => {
  const { leaseEvents, processTarget } = fixture()
  processTarget.emit('exit')
  assert.deepEqual(leaseEvents.slice(0, 3), ['stack-stopped', 'proxy-released', 'lease-released'])
})

test('synchronous runner startup failure tears down the stack and releases ownership', async () => {
  const error = new Error('spawn failed')
  const { lifecycle, leaseEvents } = fixture({ spawnError: error })
  await assert.rejects(lifecycle.run(['up']), error)
  assert.deepEqual(leaseEvents, ['stack-stopped', 'proxy-released', 'lease-released'])
})


test('a thrown cleanup error returns failure and still releases the proxy and lease', async () => {
  const { lifecycle, child, leaseEvents } = fixture({ downError: new Error('cleanup spawn failed') })
  const result = lifecycle.run(['up'])
  child.emit('close', 0, null)
  assert.equal(await result, 1)
  assert.deepEqual(leaseEvents, ['stack-stopped', 'proxy-released', 'lease-released'])
})
