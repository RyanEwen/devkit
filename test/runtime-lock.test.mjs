import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

/** Starts simultaneous contenders against abandoned admission and legacy lock records. */
test('stale recovery never admits concurrent critical sections', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'devkit-lock-race-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  symlinkSync(JSON.stringify({ pid: 0, token: 'dead' }), path.join(root, 'race.lock'))
  mkdirSync(path.join(root, 'race.tickets'))
  symlinkSync(JSON.stringify({ pid: 0, token: 'dead', ticket: null }), path.join(root, 'race.tickets/dead.ticket'))
  const script = path.join(root, 'contender.mjs')
  writeFileSync(script, `
    import { writeFileSync, unlinkSync } from 'node:fs'
    import { withRuntimeLock } from ${JSON.stringify(new URL('../src/runtime-lock.mjs', import.meta.url).href)}
    const config = { configDir: process.argv[2] }
    for (let i = 0; i < 20; i += 1) {
      withRuntimeLock(config, 'race', () => {
        const occupied = config.configDir + '/occupied'
        writeFileSync(occupied, String(process.pid), { flag: 'wx' })
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
        unlinkSync(occupied)
      })
    }
  `)
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, [script, root]))
  t.after(() => children.forEach((child) => child.kill()))
  const results = await Promise.all(children.map(async (child) => {
    let errors = ''
    child.stderr.on('data', (data) => { errors += data })
    const [code] = await once(child, 'close')
    return { code, errors }
  }))
  for (const result of results) assert.equal(result.code, 0, result.errors)
})
