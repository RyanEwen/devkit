import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { launchBackgroundRunner } from '../src/background-runner.mjs'

/** Exercises startup transport failures without creating a real detached process. */
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'devkit-detach-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const child = new EventEmitter()
  child.pid = 123
  child.connected = true
  child.disconnect = () => { child.connected = false }
  child.unref = () => { child.unreferenced = true }
  child.kill = (signal) => { child.signal = signal }
  const parent = Object.assign(new EventEmitter(), {
    execPath: process.execPath,
    execArgv: [],
    argv: ['node', '/runner.mjs', '--background', '--open=native'],
    env: {},
    cwd: () => root
  })
  return {
    child, parent,
    launch(startupTimeoutMs = 1000) {
      return launchBackgroundRunner({ configDir: root }, { slug: 'app' }, {
        processTarget: parent, startupTimeoutMs,
        spawnImpl(_command, args) {
          assert.deepEqual(args, ['/runner.mjs', '--open=native'])
          return child
        }
      })
    }
  }
}

test('unrelated IPC messages do not consume the startup acknowledgement', async (t) => {
  const { child, parent, launch } = fixture(t)
  const result = launch()
  child.emit('message', { type: 'unrelated' })
  child.emit('message', { type: 'devkit-preflight-ready' })
  assert.equal((await result).pid, 123)
  assert.equal(parent.listenerCount('SIGTERM'), 0)
  assert.equal(child.connected, false)
  assert.equal(child.unreferenced, true)
})

test('startup cancellation terminates the child and removes startup listeners', async (t) => {
  const { child, parent, launch } = fixture(t)
  const result = launch()
  parent.emit('SIGINT')
  await assert.rejects(result, /cancelled by SIGINT/)
  assert.equal(child.signal, 'SIGTERM')
  assert.equal(child.connected, false)
  assert.equal(parent.listenerCount('SIGTERM'), 0)
})

test('startup timeout releases IPC handles even if the child ignores termination', async (t) => {
  const { child, launch } = fixture(t)
  await assert.rejects(launch(10), /timed out/)
  assert.equal(child.signal, 'SIGTERM')
  assert.equal(child.unreferenced, true)
  assert.equal(child.connected, false)
})
