import { mkdirSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { processBirth, processIsAlive } from './process-identity.mjs'
export { processIsAlive } from './process-identity.mjs'

const LOCK_RETRIES = 4800
const LOCK_RETRY_MS = 25

/**
 * Serializes a named host lifecycle operation across independent project runners.
 *
 * The lock records its owner so an abruptly killed runner cannot block all future starts. Waiting
 * is synchronous because each protected operation is one short Compose invocation and callers are
 * already in synchronous host setup/teardown paths. `name` is an internal filename namespace;
 * operations must be synchronous and must not recursively acquire the same lock.
 */
export function withRuntimeLock(config, name, operation) {
  return withTicketLock(config, name, () => withLegacyLock(config, name, operation))
}

/** Keeps compatibility with older Devkit processes that still use the shared symlink lock. */
function withLegacyLock(config, name, operation) {
  mkdirSync(config.configDir, { recursive: true })
  const lockPath = path.join(config.configDir, `${name}.lock`)
  const owner = JSON.stringify({ pid: process.pid, birth: processBirth(process.pid), token: randomUUID() })

  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      // Symlink creation publishes the ownership token atomically: waiters can never observe the
      // empty-file window created by opening an exclusive file and writing its contents afterward.
      symlinkSync(owner, lockPath)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      let ownerPid = null
      let ownerBirth = null
      try {
        const parsedOwner = JSON.parse(readlinkSync(lockPath))
        if (Number.isInteger(parsedOwner?.pid)) ownerPid = parsedOwner.pid
        ownerBirth = parsedOwner?.birth
      } catch {
        // A malformed lock is stale. No writer can be mid-publish because symlink creation is atomic.
      }
      if (ownerPid === null || !processIsAlive(ownerPid, ownerBirth)) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another waiter may have recovered the same stale lock first.
        }
        continue
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS)
      continue
    }

    try {
      return operation()
    } finally {
      // Only remove the lock this invocation created. This guards against a stale-lock recovery
      // racing a paused owner that later resumes after another process has acquired the path.
      try {
        if (readlinkSync(lockPath) === owner) unlinkSync(lockPath)
      } catch {
        // A missing lock is already released; teardown must not fail while reporting that fact.
      }
    }
  }

  throw new Error(`devkit: timed out waiting for the ${name} lifecycle lock`)
}


/** Reads independent contenders, removing only dead owners' unique paths, never a shared lock. */
function contenders(directory) {
  const active = []
  for (const filename of readdirSync(directory).filter((file) => file.endsWith('.ticket'))) {
    const file = path.join(directory, filename)
    try {
      const owner = JSON.parse(readlinkSync(file))
      if (processIsAlive(owner.pid, owner.birth)) active.push(owner)
      else rmSync(file, { force: true })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return active
}

/**
 * Lamport's bakery admission serializes stale recovery as well as live operations. Every caller
 * publishes a unique choosing marker, selects a ticket, then waits for earlier tickets. Stale
 * removal can never delete a successor's reservation because token paths are never reused.
 */
function withTicketLock(config, name, operation) {
  const directory = path.join(config.configDir, `${name}.tickets`)
  mkdirSync(directory, { recursive: true })
  const owner = { pid: process.pid, birth: processBirth(process.pid), token: randomUUID(), ticket: null }
  const file = path.join(directory, `${owner.token}.ticket`)
  const temporary = `${file}.tmp`
  symlinkSync(JSON.stringify(owner), file)
  try {
    owner.ticket = Math.max(0, ...contenders(directory).map((candidate) => candidate.ticket ?? 0)) + 1
    symlinkSync(JSON.stringify(owner), temporary)
    renameSync(temporary, file)

    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      const blocked = contenders(directory).some((candidate) => {
        if (candidate.token === owner.token) return false
        if (candidate.ticket === null) return true
        return candidate.ticket < owner.ticket ||
          (candidate.ticket === owner.ticket && candidate.token < owner.token)
      })
      if (!blocked) return operation()
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS)
    }
    throw new Error(`devkit: timed out waiting for the ${name} admission lock`)
  } finally {
    rmSync(temporary, { force: true })
    rmSync(file, { force: true })
  }
}
