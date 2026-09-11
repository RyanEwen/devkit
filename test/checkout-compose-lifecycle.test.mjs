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

function fixture({ downStatus = 0 } = {}) {
  const child = new FakeChild()
  const processTarget = new EventEmitter()
  const calls = []
  const runtime = {
    process: processTarget,
    spawn(command, args, options) {
      calls.push({ type: 'spawn', command, args, options })
      return child
    },
    spawnSync(command, args, options) {
      calls.push({ type: 'spawnSync', command, args, options })
      return { status: downStatus, signal: null }
    }
  }
  const state = {
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
    child,
    lifecycle: checkoutComposeLifecycle(state, invocation, {
      profiles: ['slicer'],
      runtime
    }),
    processTarget
  }
}

test('stop includes configured profiles and tears down only once', () => {
  const { calls, lifecycle } = fixture()

  assert.equal(lifecycle.stop(), 0)
  assert.equal(lifecycle.stop(), 0)
  assert.deepEqual(calls.map(({ type, args }) => ({ type, args })), [{
    type: 'spawnSync',
    args: ['compose', '-p', 'app-test', '--profile', 'slicer', 'down', '--remove-orphans']
  }])
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
