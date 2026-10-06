import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { processBirth } from './process-identity.mjs'
import { processIsAlive, withRuntimeLock } from './runtime-lock.mjs'

/** Each checkout owns a runner lease independently of its route and Compose services. */
export function runnerFilePath(config, identity) {
  return path.join(config.configDir, 'runners', `${identity.slug}.json`)
}

/** Reads an atomically protected runner record; a dead process leaves a recoverable lease. */
function readRunner(config, identity) {
  try {
    return JSON.parse(readFileSync(runnerFilePath(config, identity), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Reserves a checkout before startup side effects, rejecting an existing live owner. Returns its
 * process identity and an idempotent release callback, also registered for normal process exit.
 * processTarget is a test seam. Abandoned records are replaced only after their owner is gone.
 */
export function acquireCheckoutRunner(config, identity, { processTarget = process } = {}) {
  const owner = { pid: processTarget.pid, birth: processBirth(processTarget.pid), token: randomUUID() }
  if (!owner.birth) throw new Error('devkit: cannot verify the runner process identity')
  withRuntimeLock(config, 'runners', () => {
    const existing = readRunner(config, identity)
    if (existing && processIsAlive(existing.pid, existing.birth)) {
      throw new Error(`devkit: this checkout is already running (PID ${existing.pid}). Stop it with the project's --down command first.`)
    }
    mkdirSync(path.dirname(runnerFilePath(config, identity)), { recursive: true })
    // Publish the complete record atomically, so a killed writer cannot leave malformed JSON
    // that blocks every future start. An interrupted temporary file is never a runner lease.
    const file = runnerFilePath(config, identity)
    const temporary = `${file}.${owner.token}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600 })
      renameSync(temporary, file)
    } finally {
      rmSync(temporary, { force: true })
    }
  })

  let released = false
  function release() {
    if (released) return
    withRuntimeLock(config, 'runners', () => {
      if (readRunner(config, identity)?.token === owner.token) {
        unlinkSync(runnerFilePath(config, identity))
      }
    })
    released = true
    processTarget.removeListener('exit', release)
  }

  processTarget.once('exit', release)
  return { ...owner, release }
}

/** Requests graceful termination, waiting for cleanup before a teardown runner claims the lease. */
export async function stopCheckoutRunner(config, identity, { timeoutMs = 30_000 } = {}) {
  const owner = withRuntimeLock(config, 'runners', () => {
    const existing = readRunner(config, identity)
    if (!existing || existing.pid === process.pid || !processIsAlive(existing.pid, existing.birth)) return null
    // Signal under the lock so another runner cannot replace the record between read and signal.
    if (!existing.birth || processBirth(existing.pid) !== existing.birth) {
      throw new Error('devkit: cannot verify the existing runner identity; refusing to signal it')
    }
    try {
      process.kill(existing.pid, 'SIGTERM')
    } catch (error) {
      if (error.code === 'ESRCH') return null
      throw error
    }
    return existing
  })
  if (!owner) return

  const deadline = Date.now() + timeoutMs
  while (processIsAlive(owner.pid, owner.birth) && withRuntimeLock(config, 'runners', () => {
    return readRunner(config, identity)?.token === owner.token
  })) {
    if (Date.now() >= deadline) {
      throw new Error(`devkit: runner ${owner.pid} did not stop; checkout teardown was cancelled`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
